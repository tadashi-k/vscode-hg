import * as path from 'path';
import * as vscode from 'vscode';
import { runHg } from './hg';

/**
 * Annotate ("blame") mode: shows the `hg annotate -u -d` output
 * (author + date) of each line as inlay hints between the line
 * number and the code, right-aligned to a common column like hg.
 * Hovering a hint shows the `hg log -v` details of the line's commit.
 */

/** "user date" prefix of each `hg annotate -u -d -q` line (code part dropped) */
export function parseAnnotate(output: string): string[] {
    const hints: string[] = [];
    for (const line of output.split('\n')) {
        const i = line.indexOf(': ');
        if (i < 0) { continue; }
        const blame = line.slice(0, i).trim();
        if (blame) {
            hints.push(blame);
        }
    }
    return hints;
}

/** 12-hex changeset node of each `hg annotate -c -q` line (code part dropped) */
export function parseAnnotateNodes(output: string): string[] {
    const nodes: string[] = [];
    for (const line of output.split('\n')) {
        const i = line.indexOf(': ');
        if (i < 0) { continue; }
        const m = line.slice(0, i).trim().match(/^([0-9a-f]{12})$/);
        if (m) {
            nodes.push(m[1]);
        }
    }
    return nodes;
}

/**
 * Right-align blame prefixes like hg does: pad each prefix with leading
 * spaces to the width of the longest one, so the code column lines up
 * (assumes the editor uses a monospace font).
 */
export function alignBlames(hints: string[]): string[] {
    const width = hints.reduce((w, h) => Math.max(w, h.length), 0);
    return hints.map(h => h.padStart(width));
}

interface AnnotateCacheEntry {
    /** display prefixes from `hg annotate -u -d -q` */
    blames: string[];
    /** per-line nodes from `hg annotate -c -q` (may be shorter if it failed) */
    nodes: string[];
    /** approximate size, to cap memory usage */
    seq: number;
}

export class HgAnnotateInlayHintsProvider implements vscode.InlayHintsProvider {
    static readonly maxLines = 5000;

    private readonly onDidChangeEmitter = new vscode.EventEmitter<void>();
    readonly onDidChangeInlayHints = this.onDidChangeEmitter.event;

    /** keyed by "root\u0000rel\u0000uriString"; entries are bumped by seq on change */
    private cache = new Map<string, AnnotateCacheEntry>();
    private cacheSeq = 0;

    /** `hg log -v` text per root\u0000node, for hints' hover tooltips */
    private logCache = new Map<string, string>();
    // (populated in batches by logForMany; one hg call per request batch)

    /** documents (by URI string) with annotate mode turned on, per-editor */
    private enabledDocs = new Set<string>();

    constructor(
        private hgPath: string,
        /** resolve the repo root of a file URI, or undefined if outside a repo */
        private findRoot: (uri: vscode.Uri) => string | undefined
    ) {}

    isEnabledFor(uri: vscode.Uri): boolean {
        return this.enabledDocs.has(uri.toString());
    }

    /** Toggle annotate mode for one document; returns the new state */
    toggleFor(uri: vscode.Uri): boolean {
        const key = uri.toString();
        if (this.enabledDocs.has(key)) {
            this.enabledDocs.delete(key);
        } else {
            this.enabledDocs.add(key);
        }
        this.onDidChangeEmitter.fire(undefined);
        return this.enabledDocs.has(key);
    }

    /** Drop cached annotations and recompute on the next request */
    invalidate(): void {
        this.cacheSeq++;
        this.onDidChangeEmitter.fire(undefined);
    }

    async provideInlayHints(
        document: vscode.TextDocument,
        range: vscode.Range
    ): Promise<vscode.InlayHint[]> {
        if (!this.enabledDocs.has(document.uri.toString())) { return []; }
        const root = this.findRoot(document.uri);
        if (!root) { return []; }

        const rel = path.relative(root, document.uri.fsPath).replace(/\\/g, '/');
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
            return [];
        }

        const key = `${root}\u0000${rel}\u0000${document.uri.toString()}`;
        let entry = this.cache.get(key);
        if (!entry || entry.seq !== this.cacheSeq) {
            // both annotate variants run in parallel to halve the wall time
            // of the first request (each is a full hg process spawn)
            const [output, nodes] = await Promise.all([
                runHg(this.hgPath, root, [
                    '--encoding', 'utf-8',
                    'annotate', '-u', '-d', '-q', '--', rel
                ]).then(parseAnnotate), // display text: exactly `hg annotate -u -d -q` (short date)
                // per-line nodes for the hover (-q alone shows only the
                // node). If it fails we just skip the hovers.
                runHg(this.hgPath, root, [
                    '--encoding', 'utf-8',
                    'annotate', '-c', '-q', '--', rel
                ]).then(parseAnnotateNodes).catch(() => [] as string[])
            ]).catch(() => undefined as unknown as [string[], string[]]);
            if (!output) {
                return []; // untracked/binary/removed files: no annotations
            }
            entry = { blames: output, nodes, seq: this.cacheSeq };
            if (this.cache.size > 100) { this.cache.clear(); }
            this.cache.set(key, entry);
        }

        const aligned = alignBlames(entry.blames);
        const hints: vscode.InlayHint[] = [];
        const hintNodes: string[] = [];
        const seenNodes = new Set<string>();
        const startLine = Math.max(0, range.start.line);
        const endLine = Math.min(document.lineCount - 1, range.end.line);
        for (let ln = startLine; ln <= endLine; ln++) {
            const blame = aligned[ln];
            if (!blame) { continue; }
            if (ln >= HgAnnotateInlayHintsProvider.maxLines) { break; }
            const node = entry.nodes[ln] ?? '';
            if (node) { seenNodes.add(node); }
            hintNodes.push(node);
            hints.push(new vscode.InlayHint(
                new vscode.Position(ln, 0),
                blame,
                vscode.InlayHintKind.Type
            ));
        }

        // fetch all tooltip texts in ONE hg call (log -v -r n1 -r n2 ...);
        // per-node calls would spawn one hg process per revision, which
        // made the first annotate toggle very slow
        const logs = await this.logForMany(root, [...seenNodes]);
        for (let i = 0; i < hints.length; i++) {
            const node = hintNodes[i];
            const text = node ? logs.get(node) : undefined;
            if (text) { hints[i].tooltip = text; }
        }
        return hints;
    }

    /**
     * `hg log -v` text per node (cached per root+node) for hint hovers.
     * Requests all missing nodes in a single `hg log -v -r a -r b ...`
     * invocation and splits the output into per-revision blocks.
     */
    private async logForMany(
        root: string,
        nodes: string[]
    ): Promise<Map<string, string>> {
        const result = new Map<string, string>();
        const missing = new Set<string>();
        for (const node of nodes) {
            const cached = this.logCache.get(`${root}\u0000${node}`);
            if (cached === undefined) {
                missing.add(node);
            } else {
                result.set(node, cached);
            }
        }
        if (missing.size > 0) {
            const args = ['--encoding', 'utf-8', 'log', '-v'];
            for (const node of missing) {
                args.push('-r', node);
            }
            let output = '';
            try {
                output = await runHg(this.hgPath, root, args);
            } catch { /* no tooltips then */ }
            const blocks = splitLogBlocks(output);
            if (this.logCache.size + blocks.size > 500) { this.logCache.clear(); }
            for (const node of missing) {
                // `hg log` prints full 40-hex nodes; our annotate nodes are
                // 12-hex, so match by prefix
                const hit = [...blocks.keys()].find(full => full.startsWith(node));
                const text = hit ? blocks.get(hit) : undefined;
                if (text !== undefined) {
                    this.logCache.set(`${root}\u0000${node}`, text);
                    result.set(node, text);
                }
            }
        }
        return result;
    }
}

/**
 * Split `hg log -v` output (multiple revisions) into one block per
 * revision, keyed by the full node from the "changeset:" header line.
 * Each block is identical to `hg log -v -r <node>` output for that rev.
 */
export function splitLogBlocks(output: string): Map<string, string> {
    const blocks = new Map<string, string>();
    let node = '';
    let lines: string[] = [];
    const flush = () => {
        if (node) { blocks.set(node, lines.join('\n')); }
    };
    for (const line of output.split('\n')) {
        // only treat exact "changeset: <rev>:<hex>" headers as boundaries,
        // so description lines that merely start with "changeset:" are safe
        const m = line.match(/^changeset:\s*\d+:([0-9a-f]{12,40})\s*$/);
        if (m) {
            flush();
            node = m[1];
            lines = [line];
        } else if (node) {
            lines.push(line);
        }
    }
    flush();
    return blocks;
}

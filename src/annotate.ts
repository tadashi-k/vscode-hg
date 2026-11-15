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
            let output = '';
            try {
                // display text: exactly `hg annotate -u -d -q` (short date)
                output = await runHg(this.hgPath, root, [
                    '--encoding', 'utf-8',
                    'annotate', '-u', '-d', '-q', '--', rel
                ]);
            } catch {
                return []; // untracked/binary/removed files: no annotations
            }
            // per-line nodes for the hover (second call; -q alone shows
            // only the node). If it fails we just skip the hovers.
            let nodes: string[] = [];
            try {
                nodes = parseAnnotateNodes(await runHg(this.hgPath, root, [
                    '--encoding', 'utf-8',
                    'annotate', '-c', '-q', '--', rel
                ]));
            } catch { /* no hover then */ }
            entry = { blames: parseAnnotate(output), nodes, seq: this.cacheSeq };
            if (this.cache.size > 100) { this.cache.clear(); }
            this.cache.set(key, entry);
        }

        const aligned = alignBlames(entry.blames);
        const hints: vscode.InlayHint[] = [];
        const seenNodes = new Set<string>();
        const startLine = Math.max(0, range.start.line);
        const endLine = Math.min(document.lineCount - 1, range.end.line);
        for (let ln = startLine; ln <= endLine; ln++) {
            const blame = aligned[ln];
            if (!blame) { continue; }
            if (ln >= HgAnnotateInlayHintsProvider.maxLines) { break; }
            const node = entry.nodes[ln] ?? '';
            if (node) { seenNodes.add(node); }
            const hint = new vscode.InlayHint(
                new vscode.Position(ln, 0),
                blame,
                vscode.InlayHintKind.Type
            );
            if (node) {
                hint.tooltip = await this.logFor(root, node);
            }
            hints.push(hint);
        }

        // fetch tooltip texts eagerly (they are cached, so the hg calls
        // happen once per unique revision)
        for (const node of seenNodes) {
            void this.logFor(root, node);
        }
        return hints;
    }

    /** `hg log -v -r <node>` output (cached per root+node) for hint hovers */
    private async logFor(root: string, node: string): Promise<string | undefined> {
        const key = `${root}\u0000${node}`;
        let text = this.logCache.get(key);
        if (text === undefined) {
            try {
                text = await runHg(this.hgPath, root, [
                    '--encoding', 'utf-8', 'log', '-v', '-r', node
                ]);
                if (this.logCache.size > 500) { this.logCache.clear(); }
                this.logCache.set(key, text);
            } catch {
                return undefined;
            }
        }
        return text;
    }
}

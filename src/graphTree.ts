import * as vscode from 'vscode';
import { fetchChangesetFiles, fetchGraph, GraphRow } from './graph';
import { relPathInRepo } from './contentProvider';

export interface RevisionPayload {
    root: string;
    rev: number;
    node: string;
}

/** Child element: one file changed by a changeset */
export interface FileEntry {
    kind: 'file';
    root: string;
    rev: number;
    node: string;
    status: string;
    relPath: string;
}

export type TreeElement = GraphRow | FileEntry;

// hex palette for tree item icons (data URIs cannot use CSS variables)
const PALETTE = ['#4fc1ff', '#b180d7', '#f19f39', '#6cd9cc', '#e06c75', '#98c379'];

// status colors: A=added(green), M=modified(amber), R=removed(red)
const STATUS_COLORS: Record<string, string> = {
    A: '#98c379',
    '?': '#98c379',
    M: '#f19f39',
    R: '#e06c75',
    '!': '#e06c75'
};

function circleIcon(color: string): vscode.Uri {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="4.5" fill="${color}"/></svg>`;
    return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

/** Index of the node symbol ('o'/'@') in the art, used for lane coloring */
function nodeColumn(art: string): number {
    for (let i = 0; i < art.length; i++) {
        if (art[i] === 'o' || art[i] === '@') { return i; }
    }
    return 0;
}

export class HgGraphTree implements vscode.TreeDataProvider<TreeElement>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeElement | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private rowsCache: GraphRow[] = [];
    private readonly payloads = new WeakMap<vscode.TreeItem, RevisionPayload>();
    private readonly filePayloads = new WeakMap<vscode.TreeItem, FileEntry>();
    private readonly subscriptions: vscode.Disposable[] = [];

    constructor(
        private readonly hgPath: string,
        private readonly getRepoRoots: () => string[],
        onRepoChange: (cb: () => void) => vscode.Disposable
    ) {
        this.subscriptions.push(onRepoChange(() => { void this.refresh(); }));
    }

    async refresh(): Promise<void> {
        const root = this.getRepoRoots()[0];
        try {
            this.rowsCache = root
                ? await fetchGraph(this.hgPath, root, this.limit())
                : [];
        } catch {
            this.rowsCache = [];
        }
        this._onDidChangeTreeData.fire(undefined);
    }

    private limit(): number {
        return vscode.workspace.getConfiguration('hg').get<number>('historyLimit', 200);
    }

    getTreeItem(element: TreeElement): vscode.TreeItem {
        if ('kind' in element && element.kind === 'file') {
            return this.getFileItem(element);
        }
        return this.getCommitItem(element as GraphRow);
    }

    private getCommitItem(row: GraphRow): vscode.TreeItem {
        const n = row.node!;
        const root = this.getRepoRoots()[0] ?? '';
        const item = new vscode.TreeItem(
            `${row.art} ${n.desc}`,
            vscode.TreeItemCollapsibleState.Collapsed // expandable -> changed files
        );
        item.description = `r${n.rev} · ${n.branch} · ${n.user} · ${n.date}`;
        item.iconPath = circleIcon(PALETTE[nodeColumn(row.art) % PALETTE.length]);
        item.tooltip = new vscode.MarkdownString(
            `**r${n.rev}** \`${n.node}\`\n\n${n.desc}\n\n${n.branch} · ${n.user} · ${n.date}\n\n*Expand to see changed files*`
        );
        item.contextValue = 'hgRevision';
        this.payloads.set(item, { root, rev: n.rev, node: n.node });
        return item;
    }

    private getFileItem(f: FileEntry): vscode.TreeItem {
        const base = f.relPath.split('/').pop() ?? f.relPath;
        const dir = f.relPath.includes('/')
            ? f.relPath.slice(0, f.relPath.lastIndexOf('/'))
            : '';
        const item = new vscode.TreeItem(base, vscode.TreeItemCollapsibleState.None);
        if (dir) { item.description = dir; }
        item.iconPath = circleIcon(STATUS_COLORS[f.status] ?? PALETTE[0]);
        item.tooltip = new vscode.MarkdownString(
            `**${f.status}** \`${f.relPath}\` at r${f.rev}\n\n*Click to show diff at this revision*`
        );
        item.command = {
            command: 'hg.showFileDiffAtRevision',
            title: 'Show Diff at Revision',
            arguments: [f.root, f.relPath, f.rev, f.node, f.status]
        };
        item.contextValue = 'hgRevisionFile';
        this.filePayloads.set(item, f);
        return item;
    }

    async getChildren(element?: TreeElement): Promise<TreeElement[]> {
        if (element && !('kind' in element) && element.node) {
            // commit expanded -> list files changed by that changeset
            const root = this.getRepoRoots()[0];
            if (!root) { return []; }
            try {
                const files = await fetchChangesetFiles(this.hgPath, root, element.node.node);
                const rels = files
                    .map(f => ({
                        kind: 'file' as const,
                        root,
                        rev: element.node!.rev,
                        node: element.node!.node,
                        status: f.status,
                        relPath: f.path
                    }));
                return rels;
            } catch {
                return [];
            }
        }
        // top level: commits only (edge-only rows are skipped)
        return this.rowsCache.filter(r => r.node);
    }

    getTreeItemPayload(item: vscode.TreeItem): RevisionPayload | undefined {
        return this.payloads.get(item);
    }

    getFileItemPayload(item: vscode.TreeItem): FileEntry | undefined {
        return this.filePayloads.get(item);
    }

    /** Current graph rows (for tests/extension API) */
    rows(): GraphRow[] {
        return this.rowsCache;
    }

    /** Guard used by context-menu commands on file items */
    relPathOf(root: string, fileUri: vscode.Uri): string | undefined {
        return relPathInRepo(root, fileUri);
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
        for (const d of this.subscriptions) { d.dispose(); }
        this.subscriptions.length = 0;
    }
}

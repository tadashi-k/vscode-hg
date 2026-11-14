import * as vscode from 'vscode';
import { fetchGraph, GraphRow } from './graph';

export interface RevisionPayload {
    root: string;
    rev: number;
    node: string;
}

// hex palette for tree item icons (data URIs cannot use CSS variables)
const PALETTE = ['#4fc1ff', '#b180d7', '#f19f39', '#6cd9cc', '#e06c75', '#98c379'];

function dotIcon(colorIndex: number): vscode.Uri {
    const color = PALETTE[colorIndex % PALETTE.length];
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

export class HgGraphTree implements vscode.TreeDataProvider<GraphRow>, vscode.Disposable {
    private _onDidChangeTreeData = new vscode.EventEmitter<GraphRow | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    private rowsCache: GraphRow[] = [];
    private readonly payloads = new WeakMap<vscode.TreeItem, RevisionPayload>();
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

    getTreeItem(row: GraphRow): vscode.TreeItem {
        const n = row.node!;
        const root = this.getRepoRoots()[0] ?? '';
        const item = new vscode.TreeItem(
            `${row.art} ${n.desc}`,
            vscode.TreeItemCollapsibleState.None
        );
        item.description = `r${n.rev} · ${n.branch} · ${n.user} · ${n.date}`;
        item.iconPath = dotIcon(nodeColumn(row.art));
        item.tooltip = new vscode.MarkdownString(
            `**r${n.rev}** \`${n.node}\`\n\n${n.desc}\n\n${n.branch} · ${n.user} · ${n.date}`
        );
        item.command = {
            command: 'hg.showRevisionDetails',
            title: 'Show Revision Details',
            arguments: [root, n.rev, n.node]
        };
        item.contextValue = 'hgRevision';
        this.payloads.set(item, { root, rev: n.rev, node: n.node });
        return item;
    }

    async getChildren(): Promise<GraphRow[]> {
        return this.rowsCache.filter(r => r.node);
    }

    getTreeItemPayload(item: vscode.TreeItem): RevisionPayload | undefined {
        return this.payloads.get(item);
    }

    /** Current graph rows (for tests/extension API) */
    rows(): GraphRow[] {
        return this.rowsCache;
    }

    dispose(): void {
        this._onDidChangeTreeData.dispose();
        for (const d of this.subscriptions) { d.dispose(); }
        this.subscriptions.length = 0;
    }
}

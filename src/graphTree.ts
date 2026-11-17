import * as path from 'path';
import * as vscode from 'vscode';
import { hgFileUri } from './decorations';
import {
    escapeHtml, fetchChangesetFiles, fetchGraph, GraphRow, rowIconUri
} from './graph';

/** True for art rows that are pure lane connectors (| : . space) */
function isConnectorOnly(art: string): boolean {
    return /^[\|:. ]*$/.test(art.trimEnd());
}

type CommitData = {
    kind: 'commit';
    root: string;
    rev: number;
    node: string;
    desc: string;
    user: string;
    date: string;
    branch: string;
};

type FileData = {
    kind: 'file';
    root: string;
    path: string;
    status: string;
    rev: number;
    node: string;
};

/** Plain-object shape returned by dumpTree (tests / debugging) */
export interface TreeDump {
    kind: string;
    label?: string;
    description?: string;
    tooltip?: string;
    node?: string;
    hasIcon: boolean;
}

/** TreeItem subclass carrying the payload its commands need */
export class HgTreeItem extends vscode.TreeItem {
    constructor(
        label: string,
        collapsibleState: vscode.TreeItemCollapsibleState,
        readonly data: CommitData | FileData
    ) {
        super(label, collapsibleState);
    }
}

/**
 * The history Graph as a NATIVE tree view (like the built-in Git graph):
 * - native workbench hovers that overflow the Source Control panel into
 *   the editor (impossible from a webview),
 * - native context menu via view/item/context menu contributions,
 * - changed files as lazily-fetched children of each commit.
 * The graph art itself is rendered as a small SVG icon per row (colored
 * lanes, S-curves, ring for the working-copy parent).
 */
export class HgGraphTree implements vscode.TreeDataProvider<vscode.TreeItem>, vscode.Disposable {
    /** set by the extension after createTreeView (tests: isResolved) */
    view?: vscode.TreeView<vscode.TreeItem>;

    private rowsCache: GraphRow[] = [];

    private readonly onDidChangeEmitter =
        new vscode.EventEmitter<vscode.TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this.onDidChangeEmitter.event;

    constructor(
        private readonly hgPath: string,
        private readonly getRepoRoots: () => string[],
        onRepoChange: (cb: () => void) => vscode.Disposable
    ) {
        onRepoChange(() => { void this.refresh(); });
    }

    get isResolved(): boolean {
        return this.view !== undefined;
    }

    /** Current graph rows (extension API / tests) */
    rows(): GraphRow[] {
        return this.rowsCache;
    }

    /** Files changed by a changeset (extension API / tests) */
    async changedFiles(node: string): Promise<{ status: string; path: string }[]> {
        const root = this.getRepoRoots()[0];
        if (!root) { return []; }
        return await fetchChangesetFiles(this.hgPath, root, node);
    }

    /** Flat dump of the top-level tree rows (tests / debugging) */
    async dumpTree(): Promise<TreeDump[]> {
        const children = await this.getChildren();
        return children.map(it => {
            const data = it instanceof HgTreeItem ? it.data : undefined;
            const tooltip = typeof it.tooltip === 'string'
                ? it.tooltip
                : it.tooltip instanceof vscode.MarkdownString ? it.tooltip.value : undefined;
            return {
                kind: data?.kind ?? 'edge',
                label: typeof it.label === 'string' ? it.label : undefined,
                description: typeof it.description === 'string' ? it.description : undefined,
                tooltip,
                node: data?.kind === 'commit' ? data.node : undefined,
                hasIcon: it.iconPath !== undefined
            };
        });
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
        this.onDidChangeEmitter.fire();
    }

    private limit(): number {
        return vscode.workspace.getConfiguration('hg').get<number>('historyLimit', 200);
    }

    async getTreeItem(item: vscode.TreeItem): Promise<vscode.TreeItem> {
        return item; // items are fully built in getChildren
    }

    /** required by TreeView.reveal() so the latest commit can auto-expand */
    getParent(element: vscode.TreeItem): vscode.ProviderResult<vscode.TreeItem> {
        if (element instanceof HgTreeItem && element.data.kind === 'file') {
            const root = this.getRepoRoots()[0];
            const row = root
                ? this.rowsCache.find(r => r.node?.node === element.data.node)
                : undefined;
            return row ? this.buildCommitItem(root, row) : undefined;
        }
        return undefined; // commit rows are root-level
    }

    async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
        if (!element) {
            const root = this.getRepoRoots()[0];
            if (!root) { return []; }
            if (this.rowsCache.length === 0) {
                try {
                    this.rowsCache = await fetchGraph(this.hgPath, root, this.limit());
                } catch {
                    this.rowsCache = [];
                }
            }
            return this.buildCommitRows(root);
        }
        if (element instanceof HgTreeItem && element.data.kind === 'commit') {
            return this.buildFileItems(element.data);
        }
        return [];
    }

    private buildCommitRows(root: string): vscode.TreeItem[] {
        const items: vscode.TreeItem[] = [];
        for (const row of this.rowsCache) {
            if (row.node) {
                items.push(this.buildCommitItem(root, row));
            } else if (!isConnectorOnly(row.art)) {
                // fork/merge edge rows: blank row carrying only the curve
                const edge = new vscode.TreeItem('', vscode.TreeItemCollapsibleState.None);
                edge.iconPath = rowIconUri(row.art, false);
                edge.contextValue = 'hg.edge';
                items.push(edge);
            }
            // pure connector rows are skipped: the lane continues through
            // the icons of the surrounding rows
        }
        return items;
    }

    private buildCommitItem(root: string, row: GraphRow): vscode.TreeItem {
        const n = row.node!;
        const item = new HgTreeItem(n.desc, vscode.TreeItemCollapsibleState.Collapsed, {
            kind: 'commit',
            root,
            rev: n.rev,
            node: n.node,
            desc: n.desc,
            user: n.user,
            date: n.date,
            branch: n.branch
        });
        item.description = n.user; // grey author text right of the title, like Git
        item.iconPath = rowIconUri(row.art, true);
        item.contextValue = 'hg.commit';

        // native workbench hover (overflows the SCM panel into the editor)
        const md = new vscode.MarkdownString();
        md.appendMarkdown(`**${escapeHtml(n.desc)}**\n\n`);
        md.appendMarkdown(`${escapeHtml(n.user)} · ${escapeHtml(n.date)}\n\n`);
        md.appendMarkdown(`r${n.rev} · ${escapeHtml(n.branch)} · \`${n.node}\``);
        item.tooltip = md;
        return item;
    }

    private async buildFileItems(data: CommitData): Promise<vscode.TreeItem[]> {
        const files = await this.changedFiles(data.node);
        return files.map(f => {
            // like Git's graph rows: basename label, folder path as grey
            // text, and a colored status badge at the row's right end (the
            // badge comes from HgGraphFileDecorationProvider via the
            // 'hg-file' resourceUri, which carries this commit's status)
            const dir = path.dirname(f.path).replace(/\\/g, '/');
            const item = new HgTreeItem(path.basename(f.path), vscode.TreeItemCollapsibleState.None, {
                kind: 'file',
                root: data.root,
                path: f.path,
                status: f.status,
                rev: data.rev,
                node: data.node
            });
            item.resourceUri = hgFileUri(f.path, f.status);
            item.description = dir === '.' ? undefined : dir;
            item.command = {
                command: 'hg.showFileDiffAtRevision',
                title: 'Show Diff',
                arguments: [data.root, f.path, data.rev, data.node, f.status]
            };
            item.contextValue = 'hg.file';
            return item;
        });
    }

    /** Expand the newest commit's file list (visual badge verification) */
    async revealLatestCommit(): Promise<void> {
        if (!this.view) { return; }
        await this.refresh();
        const children = await this.getChildren();
        const firstCommit = children.find(c => c instanceof HgTreeItem &&
            (c as HgTreeItem).data.kind === 'commit');
        if (firstCommit) {
            await this.view.reveal(firstCommit, { expand: 1, select: true });
        }
    }

    dispose(): void {
        this.onDidChangeEmitter.dispose();
    }
}



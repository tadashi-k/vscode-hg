import * as vscode from 'vscode';
import { artToHtml, escapeHtml, fetchGraph, GraphRow } from './graph';
import { showRevisionDetails, showRevisionDiff, updateToRevision } from './revisions';


export class HgGraphView implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private rowsCache: GraphRow[] = [];
    private disposables: vscode.Disposable[] = [];

    constructor(
        private readonly hgPath: string,
        private readonly getRepoRoots: () => string[],
        private readonly onRepoChange: (cb: () => void) => vscode.Disposable
    ) { }

    /** Current parsed graph rows (nodes + edge-only lines) */
    rows(): GraphRow[] {
        return this.rowsCache;
    }

    show(): void {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active);
            void this.refresh();
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'hg.historyGraph',
            'Mercurial History',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );
        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
        this.disposables.push(
            this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg)),
            this.onRepoChange(() => { if (this.panel) { void this.refresh(); } })
        );

        void this.refresh();
    }

    async refresh(): Promise<void> {
        const panel = this.panel;
        if (!panel) { return; }
        const roots = this.getRepoRoots();
        if (roots.length === 0) {
            panel.webview.html = emptyHtml('No Mercurial repository is open.');
            return;
        }
        const root = roots[0];
        const limit = vscode.workspace.getConfiguration('hg').get<number>('historyLimit', 200);

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Window, title: 'Mercurial: loading history graph' },
            async () => {
                try {
                    this.rowsCache = await fetchGraph(this.hgPath, root, limit);
                    panel.webview.html = this.renderHtml(root, limit);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    panel.webview.html = emptyHtml(`Failed to load history: ${escapeHtml(msg)}`);
                }
            }
        );
    }

    private async onMessage(msg: { type: string; rev?: number; node?: string }): Promise<void> {
        const root = this.getRepoRoots()[0];
        if (!root) { return; }
        try {
            switch (msg.type) {
                case 'refresh':
                    await this.refresh();
                    break;
                case 'details':
                    if (msg.node !== undefined && msg.rev !== undefined) {
                        await showRevisionDetails(this.hgPath, root, msg.rev, msg.node);
                    }
                    break;
                case 'diff':
                    if (msg.node !== undefined && msg.rev !== undefined) {
                        await showRevisionDiff(this.hgPath, root, msg.rev, msg.node);
                    }
                    break;
                case 'update':
                    if (msg.rev !== undefined) {
                        await updateToRevision(this.hgPath, root, msg.rev);
                        await this.refresh();
                    }
                    break;
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Mercurial: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    private renderHtml(root: string, limit: number): string {
        const nonce = Math.random().toString(36).slice(2);
        const rowsHtml = this.rowsCache.map(row => {
            const art = artToHtml(row.art);
            if (!row.node) {
                return `<tr class="edge"><td class="art">${art}</td><td colspan="5"></td></tr>`;
            }
            const n = row.node;
            return `<tr class="cs" data-rev="${n.rev}" data-node="${escapeHtml(n.node)}" title="Click for details">
                <td class="art">${art}</td>
                <td class="rev">${n.rev}</td>
                <td class="branch">${escapeHtml(n.branch)}</td>
                <td class="user">${escapeHtml(n.user)}</td>
                <td class="date">${escapeHtml(n.date)}</td>
                <td class="desc" title="${escapeHtml(n.desc)}">${escapeHtml(n.desc)}</td>
            </tr>`;
        }).join('\n');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
    :root {
        --hg-graph-c1: #4fc1ff;
        --hg-graph-c2: #b180d7;
        --hg-graph-c3: #f19f39;
        --hg-graph-c4: #6cd9cc;
        --hg-graph-c5: #e06c75;
        --hg-graph-c6: #98c379;
    }
    body {
        color: var(--vscode-editor-foreground);
        background: var(--vscode-editor-background);
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 13px);
        margin: 0;
        padding: 8px;
    }
    .toolbar {
        position: sticky; top: 0; z-index: 1;
        display: flex; align-items: center; gap: 8px;
        padding: 6px 8px;
        background: var(--vscode-editor-background);
        border-bottom: 1px solid var(--vscode-panel-border, transparent);
    }
    .toolbar .repo { opacity: .7; margin-right: auto; overflow: hidden; text-overflow: ellipsis; }
    button {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: none; border-radius: 2px;
        padding: 4px 10px; cursor: pointer;
        font-size: 12px;
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    table { border-collapse: collapse; width: 100%; table-layout: fixed; }
    th {
        text-align: left; font-weight: normal; opacity: .6;
        position: sticky; top: 37px;
        background: var(--vscode-editor-background);
        padding: 4px 8px;
        border-bottom: 1px solid var(--vscode-panel-border, transparent);
    }
    td { padding: 2px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    tr.edge td { padding: 0 8px; line-height: 1.0; }
    tr.cs:hover td { background: var(--vscode-list-hoverBackground); cursor: pointer; }
    tr.cs:hover .actions { visibility: visible; }
    td.art { width: 90px; font-family: var(--vscode-editor-font-family, monospace); }
    td.rev { width: 50px; color: var(--vscode-textLink-foreground); }
    td.branch { width: 90px; }
    td.user { width: 120px; opacity: .8; }
    td.date { width: 95px; opacity: .6; }
    td.desc { width: auto; }
    .actions { visibility: hidden; width: 110px; white-space: nowrap; }
    .actions button { padding: 0 6px; margin-right: 4px; font-size: 11px; }
</style>
</head>
<body>
<div class="toolbar">
    <span class="repo">${escapeHtml(root)}</span>
    <span style="opacity:.6">last ${limit} revisions</span>
    <button data-action="refresh">Refresh</button>
</div>
<table>
<thead>
    <tr><th></th><th>Rev</th><th>Branch</th><th>Author</th><th>Date</th><th>Description</th><th></th></tr>
</thead>
<tbody>
${rowsHtml}
</tbody>
</table>
<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelector('button[data-action=refresh]').addEventListener('click', () =>
        vscode.postMessage({ type: 'refresh' }));

    document.querySelectorAll('tr.cs').forEach(tr => {
        const rev = tr.dataset.rev;
        const node = tr.dataset.node;
        tr.addEventListener('click', () => vscode.postMessage({ type: 'details', rev, node }));
        tr.addEventListener('contextmenu', e => {
            e.preventDefault();
            const menu = document.createElement('div');
            menu.innerHTML =
                '<button data-a="diff">Show Diff</button>' +
                '<button data-a="update">Update to r' + rev + '</button>';
            menu.style.cssText = 'position:fixed;left:' + e.clientX + 'px;top:' + e.clientY + 'px;' +
                'background:var(--vscode-menu-background);color:var(--vscode-menu-foreground);' +
                'border:1px solid var(--vscode-menu-border);padding:4px;z-index:9;display:flex;gap:4px;';
            document.body.appendChild(menu);
            menu.addEventListener('click', ev => {
                const a = ev.target?.dataset?.a;
                menu.remove();
                if (a === 'diff') { vscode.postMessage({ type: 'diff', rev, node }); }
                if (a === 'update') { vscode.postMessage({ type: 'update', rev, node }); }
            });
            setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
        });
    });
</script>
</body>
</html>`;
    }

    dispose(): void {
        this.panel?.dispose();
        this.panel = undefined;
        for (const d of this.disposables) { d.dispose(); }
        this.disposables = [];
    }
}

function emptyHtml(message: string): string {
    return `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:20px;color:var(--vscode-editor-foreground)">${message}</body></html>`;
}

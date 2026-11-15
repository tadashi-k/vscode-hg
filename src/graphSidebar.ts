import * as vscode from 'vscode';
import { artToHtml, escapeHtml, fetchChangesetFiles, fetchGraph, GraphRow } from './graph';
import { showFileDiffAtRevision, showRevisionDetails, showRevisionDiff, updateToRevision } from './revisions';

interface Message {
    type: 'refresh' | 'changes' | 'fileDiff' | 'commitDiff' | 'update' | 'details';
    rev?: number;
    node?: string;
    path?: string;
    status?: string;
}

const COL_W = 11;

// hex palette (webview SVG can use plain hex; matches CSS var palette order)
const PALETTE = ['#4fc1ff', '#b180d7', '#f19f39', '#6cd9cc', '#e06c75', '#98c379'];

function colorAt(col: number): string {
    return PALETTE[((col % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

/**
 * Render one row of `hg log -G` art as an SVG cell.
 * Geometry: char at index i occupies column i; x-center = (i + 0.5) * COL_W.
 *  '|' vertical at its column;  '\' top(x(i-1)) -> bottom(x(i));
 *  '/' top(x(i)) -> bottom(x(i-1)); node chars get a dot with vertical stubs.
 */
function rowArtSvg(art: string, h: number, isCommit: boolean): string {
    const width = Math.max(art.length, 2) * COL_W;
    const parts: string[] = [];
    const x = (i: number): number => (i + 0.5) * COL_W;

    for (let i = 0; i < art.length; i++) {
        const c = art[i];
        const color = colorAt(i);
        const xi = x(i);
        switch (c) {
            case ' ':
                break;
            case '|':
            case ':':
            case '.':
            case '+':
                parts.push(`<line x1="${xi}" y1="0" x2="${xi}" y2="${h}" stroke="${color}" stroke-width="1.5"/>`);
                break;
            case '\\':
                // edge moves from column i-1 (top) to column i (bottom)
                parts.push(`<line x1="${xi - COL_W}" y1="0" x2="${xi}" y2="${h}" stroke="${color}" stroke-width="1.5"/>`);
                break;
            case '/':
                // edge moves from column i (top) to column i-1 (bottom)
                parts.push(`<line x1="${xi}" y1="0" x2="${xi - COL_W}" y2="${h}" stroke="${color}" stroke-width="1.5"/>`);
                break;
            case '_':
                parts.push(`<line x1="${xi}" y1="${h / 2}" x2="${xi + COL_W}" y2="${h / 2}" stroke="${color}" stroke-width="1.5"/>`);
                break;
            case 'o':
            case '@':
            case 'x': {
                const r = 3.5;
                if (isCommit) {
                    parts.push(`<line x1="${xi}" y1="0" x2="${xi}" y2="${h / 2 - r}" stroke="${color}" stroke-width="1.5"/>`);
                    parts.push(`<line x1="${xi}" y1="${h / 2 + r}" x2="${xi}" y2="${h}" stroke="${color}" stroke-width="1.5"/>`);
                }
                parts.push(`<circle cx="${xi}" cy="${h / 2}" r="${r}" fill="${color}"${c === 'x' ? ' fill-opacity="0.4"' : ''}/>`);
                break;
            }
            default:
                break;
        }
    }
    return `<svg class="art" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${parts.join('')}</svg>`;
}

export class HgGraphSidebar implements vscode.WebviewViewProvider, vscode.Disposable {
    public static readonly viewId = 'hg.graph';

    private view?: vscode.WebviewView;
    private rowsCache: GraphRow[] = [];

    constructor(
        private readonly hgPath: string,
        private readonly getRepoRoots: () => string[],
        onRepoChange: (cb: () => void) => vscode.Disposable
    ) {
        onRepoChange(() => { void this.refresh(); });
    }

    resolveWebviewView(view: vscode.WebviewView): void {
        this.view = view;
        view.webview.options = { enableScripts: true, localResourceRoots: [] };
        view.webview.onDidReceiveMessage(msg => { void this.onMessage(msg as Message); });
        view.webview.html = this.renderHtml();
    }

    /** Current graph rows (extension API / tests) */
    rows(): GraphRow[] {
        return this.rowsCache;
    }

    /** True once VS Code resolved (rendered) the webview view */
    get isResolved(): boolean {
        return this.view !== undefined;
    }

    /** Files changed by a changeset (extension API / tests) */
    async changedFiles(node: string): Promise<{ status: string; path: string }[]> {
        const root = this.getRepoRoots()[0];
        if (!root) { return []; }
        return await fetchChangesetFiles(this.hgPath, root, node);
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
        if (this.view) {
            this.view.webview.html = this.renderHtml();
        }
    }

    private limit(): number {
        return vscode.workspace.getConfiguration('hg').get<number>('historyLimit', 200);
    }

    private async onMessage(msg: Message): Promise<void> {
        const root = this.getRepoRoots()[0];
        if (!root) { return; }
        try {
            switch (msg.type) {
                case 'refresh':
                    await this.refresh();
                    break;
                case 'changes': {
                    if (msg.node === undefined || msg.rev === undefined) { break; }
                    const files = await fetchChangesetFiles(this.hgPath, root, msg.node);
                    const info = this.rowsCache.find(r => r.node?.rev === msg.rev)?.node;
                    void this.view?.webview.postMessage({
                        type: 'changes',
                        rev: msg.rev,
                        node: msg.node,
                        desc: info?.desc ?? '',
                        branch: info?.branch ?? '',
                        files
                    });
                    break;
                }
                case 'fileDiff':
                    if (msg.node !== undefined && msg.rev !== undefined && msg.path) {
                        await showFileDiffAtRevision(this.hgPath, root, msg.path, msg.rev, msg.node, msg.status ?? 'M');
                    }
                    break;
                case 'commitDiff':
                    if (msg.node !== undefined && msg.rev !== undefined) {
                        await showRevisionDiff(this.hgPath, root, msg.rev, msg.node);
                    }
                    break;
                case 'details':
                    if (msg.node !== undefined && msg.rev !== undefined) {
                        await showRevisionDetails(this.hgPath, root, msg.rev, msg.node);
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

    private renderHtml(): string {
        const nonce = Math.random().toString(36).slice(2);
        const root = this.getRepoRoots()[0] ?? '';

        const rowsHtml = this.rowsCache.map(row => {
            const isCommit = !!row.node;
            const h = isCommit ? 38 : 8;
            const art = rowArtSvg(row.art, h, isCommit);
            if (!isCommit) {
                return `<div class="row edge">${art}<div class="info"></div></div>`;
            }
            const n = row.node!;
            return `<div class="row commit" data-rev="${n.rev}" data-node="${escapeHtml(n.node)}" title="Click to show changed files">
                ${art}
                <div class="info">
                    <div class="title">${escapeHtml(n.desc)}</div>
                    <div class="meta">r${n.rev} · ${escapeHtml(n.branch)} · ${escapeHtml(n.user)} · ${escapeHtml(n.date)}</div>
                    <div class="files" data-rev="${n.rev}"></div>
                </div>
            </div>`;
        }).join('\n');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
    :root {
        --hg-graph-c1: #4fc1ff; --hg-graph-c2: #b180d7; --hg-graph-c3: #f19f39;
        --hg-graph-c4: #6cd9cc; --hg-graph-c5: #e06c75; --hg-graph-c6: #98c379;
    }
    body {
        color: var(--vscode-sideBar-foreground, var(--vscode-editor-foreground));
        background: transparent;
        font-family: var(--vscode-editor-font-family, monospace);
        font-size: var(--vscode-editor-font-size, 12px);
        margin: 0; padding: 0;
    }
    .toolbar {
        position: sticky; top: 0; z-index: 1;
        display: flex; align-items: center; gap: 8px;
        padding: 4px 8px;
        background: var(--vscode-sideBar-background, var(--vscode-editor-background));
        border-bottom: 1px solid var(--vscode-panel-border, transparent);
    }
    .toolbar .repo { opacity: .6; margin-right: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    button {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
        border: none; border-radius: 2px;
        padding: 3px 9px; cursor: pointer; font-size: 11px;
    }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .row { display: flex; align-items: stretch; }
    .row .art { flex: none; }
    .row.commit { cursor: pointer; padding: 2px 0; }
    .row.commit:hover { background: var(--vscode-list-hoverBackground); }
    .row.commit.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .info { min-width: 0; padding: 3px 8px 3px 2px; }
    .title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .meta { opacity: .7; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .files { display: none; margin: 4px 0 2px 8px; }
    .files.open { display: block; }
    .file { display: flex; gap: 6px; padding: 1px 6px; border-radius: 3px; cursor: pointer; white-space: nowrap; }
    .file:hover { background: var(--vscode-list-hoverBackground); }
    .badge { font-weight: bold; width: 12px; text-align: center; }
    .st-M .badge { color: #f19f39; }
    .st-A .badge { color: #98c379; }
    .st-R .badge, .st-! .badge { color: #e06c75; }
    .menu {
        position: fixed; z-index: 9; display: flex; flex-direction: column; gap: 2px;
        background: var(--vscode-menu-background); color: var(--vscode-menu-foreground);
        border: 1px solid var(--vscode-menu-border); padding: 4px; min-width: 140px;
    }
    .menu button { background: transparent; color: inherit; text-align: left; padding: 4px 8px; }
    .menu button:hover { background: var(--vscode-menu-selectionBackground); }
</style>
</head>
<body>
<div class="toolbar">
    <span class="repo">${escapeHtml(root)}</span>
    <button data-action="refresh">Refresh</button>
</div>
<div id="list">
${rowsHtml}
</div>
<script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const list = document.getElementById('list');

    document.querySelector('button[data-action=refresh]').addEventListener('click', () =>
        vscode.postMessage({ type: 'refresh' }));

    function toggleFiles(row) {
        const files = row.querySelector('.files');
        const wasOpen = files.classList.contains('open');
        document.querySelectorAll('.files.open').forEach(f => f.classList.remove('open'));
        document.querySelectorAll('.row.commit.selected').forEach(r => r.classList.remove('selected'));
        if (wasOpen) { return; }
        row.classList.add('selected');
        vscode.postMessage({ type: 'changes', rev: row.dataset.rev, node: row.dataset.node });
    }

    function renderFiles(rev, node, desc, branch, files) {
        const row = list.querySelector('.row.commit[data-rev="' + rev + '"]');
        if (!row) { return; }
        const container = row.querySelector('.files');
        container.textContent = '';
        const head = document.createElement('div');
        head.className = 'meta';
        head.textContent = desc + (branch ? ' (' + branch + ')' : '');
        container.appendChild(head);
        if (!files || files.length === 0) {
            const none = document.createElement('div');
            none.textContent = 'no changed files';
            none.style.opacity = '.6';
            container.appendChild(none);
        }
        for (const f of files) {
            const chip = document.createElement('div');
            chip.className = 'file st-' + f.status;
            chip.title = 'Click to show diff at r' + rev;
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = f.status;
            chip.appendChild(badge);
            chip.appendChild(document.createTextNode(f.path));
            chip.addEventListener('click', ev => {
                // do not bubble up to the commit row (which toggles the file list)
                ev.stopPropagation();
                vscode.postMessage({
                    type: 'fileDiff', rev, node, path: f.path, status: f.status
                });
            });
            container.appendChild(chip);
        }
        container.classList.add('open');
    }

    window.addEventListener('message', e => {
        const m = e.data;
        if (m && m.type === 'changes') { renderFiles(m.rev, m.node, m.desc, m.branch, m.files); }
    });

    list.querySelectorAll('.row.commit').forEach(row => {
        row.addEventListener('click', () => toggleFiles(row));
        row.addEventListener('contextmenu', e => {
            e.preventDefault();
            e.stopPropagation();
            const rev = row.dataset.rev;
            const node = row.dataset.node;
            const menu = document.createElement('div');
            menu.className = 'menu';
            menu.innerHTML =
                '<button data-a="details">Show Details</button>' +
                '<button data-a="commitDiff">Show Commit Diff</button>' +
                '<button data-a="update">Update to r' + rev + '</button>';
            menu.style.left = Math.min(e.clientX, window.innerWidth - 160) + 'px';
            menu.style.top = e.clientY + 'px';
            document.body.appendChild(menu);
            menu.addEventListener('click', ev => {
                const a = ev.target?.dataset?.a;
                menu.remove();
                if (a === 'details') { vscode.postMessage({ type: 'details', rev, node }); }
                if (a === 'commitDiff') { vscode.postMessage({ type: 'commitDiff', rev, node }); }
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
        this.view = undefined;
    }
}

// re-export for convenience in tests that render art elsewhere
export { artToHtml };

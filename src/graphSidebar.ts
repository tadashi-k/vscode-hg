import * as vscode from 'vscode';
import { artToHtml, escapeHtml, fetchChangesetFiles, fetchGraph, GraphRow } from './graph';
import { showFileDiffAtRevision, showRevisionDetails, showRevisionDiff, updateToRevision } from './revisions';

interface Message {
    type: 'refresh' | 'changes' | 'fileDiff' | 'commitDiff' | 'update' | 'details' | 'dump';
    rev?: number;
    node?: string;
    path?: string;
    status?: string;
    /** reply payload of 'dump' */
    html?: string;
}

const COL_W = 11;
/** every row is one text line high, like the built-in Git graph */
const ROW_H = 22;
const NODE_R = 4;

// hex palette (webview SVG can use plain hex; matches CSS var palette order)
const PALETTE = ['#4fc1ff', '#b180d7', '#f19f39', '#6cd9cc', '#e06c75', '#98c379'];

function colorAt(col: number): string {
    return PALETTE[((col % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

/**
 * Render one row of `hg log -G` art as an SVG cell, styled like the
 * built-in Git graph: every row is one text line high, lanes run
 * continuously through the rows and branch/merge edges are smooth
 * S-curves.
 * Geometry: char at index i occupies column i; x-center = (i + 0.5) * COL_W.
 *  '|' vertical at its column;  '\\' top(x(i-1)) -> bottom(x(i));
 *  '/' top(x(i)) -> bottom(x(i-1)); node chars get a dot with vertical stubs.
 */
function rowArtSvg(art: string, isCommit: boolean, width: number, h: number = ROW_H): string {
    const parts: string[] = [];
    const x = (i: number): number => (i + 0.5) * COL_W;
    const W = '1.5';

    for (let i = 0; i < art.length; i++) {
        const c = art[i];
        if (c === ' ') { continue; }
        const color = colorAt(i);
        const xi = x(i);
        switch (c) {
            case '|':
            case ':':
            case '.':
            case '+':
                parts.push(`<line x1="${xi}" y1="0" x2="${xi}" y2="${h}" stroke="${color}" stroke-width="${W}"/>`);
                break;
            case '\\': {
                // edge moves from column i-1 (top) to column i (bottom),
                // drawn as a smooth S-curve like Git
                const x1 = x(i - 1);
                parts.push(`<path d="M ${x1} 0 Q ${(x1 + xi) / 2} ${h / 2} ${xi} ${h}" stroke="${color}" stroke-width="${W}" fill="none"/>`);
                break;
            }
            case '/': {
                // edge moves from column i (top) to column i-1 (bottom)
                const x2 = x(i - 1);
                parts.push(`<path d="M ${xi} 0 Q ${(xi + x2) / 2} ${h / 2} ${x2} ${h}" stroke="${color}" stroke-width="${W}" fill="none"/>`);
                break;
            }
            case '_':
                parts.push(`<line x1="${xi}" y1="${h / 2}" x2="${xi + COL_W}" y2="${h / 2}" stroke="${color}" stroke-width="${W}"/>`);
                break;
            case 'o':
            case '@':
            case 'x': {
                // '@' marks the working-copy parent (the newest revision);
                // draw it as a hollow ring like Git draws the HEAD commit
                const r = c === '@' ? 5 : NODE_R;
                if (isCommit) {
                    parts.push(`<line x1="${xi}" y1="0" x2="${xi}" y2="${h / 2 - r}" stroke="${color}" stroke-width="${W}"/>`);
                    parts.push(`<line x1="${xi}" y1="${h / 2 + r}" x2="${xi}" y2="${h}" stroke="${color}" stroke-width="${W}"/>`);
                }
                if (c === '@') {
                    parts.push(`<circle cx="${xi}" cy="${h / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="2"/>`);
                } else {
                    parts.push(`<circle cx="${xi}" cy="${h / 2}" r="${r}" fill="${color}"${c === 'x' ? ' fill-opacity="0.4"' : ''}/>`);
                }
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

    /**
     * Ask the webview for its current rendered markup (tests/debugging).
     * Resolves to '' if the view is not resolved or does not answer in time.
     */
    dumpHtml(): Promise<string> {
        return new Promise(resolve => {
            if (!this.view) { resolve(''); return; }
            let settled = false;
            const done = (html: string) => {
                if (settled) { return; }
                settled = true;
                this.dumpResolve = undefined;
                resolve(html);
            };
            this.dumpResolve = done;
            void this.view.webview.postMessage({ type: 'dump' });
            setTimeout(() => done(''), 5000);
        });
    }

    private dumpResolve?: (html: string) => void;

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
                case 'dump':
                    if (this.dumpResolve && typeof msg.html === 'string') {
                        this.dumpResolve(msg.html);
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

        // fixed-width graph gutter so the text column lines up (like Git)
        const artWidth = Math.max(3, ...this.rowsCache.map(r => r.art.length)) * COL_W;

        const rowsHtml = this.rowsCache.map(row => {
            const isCommit = !!row.node;
            // hg's `log -G` prints a pure '|' connector row between every
            // pair of changesets; Git has no such spacing, so collapse
            // them to zero height (the lane stays continuous via the
            // commit rows' line stubs). Rows carrying curves/merges keep
            // full height so the edges remain visible.
            const collapse = !isCommit && /^[|:. ]*$/.test(row.art.trimEnd());
            const art = rowArtSvg(row.art, isCommit, artWidth, collapse ? 0 : ROW_H);
            if (!isCommit) {
                return `<div class="row edge${collapse ? ' collapse' : ''}">`
                    + (collapse ? '' : `${art}<div class="info"></div>`)
                    + `</div>`;
            }
            const n = row.node!;
            return `<div class="row commit" data-rev="${n.rev}" data-node="${escapeHtml(n.node)}">
                ${art}
                <div class="info">
                    <div class="title"><span class="desc">${escapeHtml(n.desc)}</span><span class="author">${escapeHtml(n.user)}</span></div>
                    <div class="files" data-rev="${n.rev}"></div>
                </div>
                <div class="tooltip">
                    <div class="tt-title">${escapeHtml(n.desc)}</div>
                    <div class="tt-meta">${escapeHtml(n.user)} · r${n.rev} · ${escapeHtml(n.branch)} · ${escapeHtml(n.date)}</div>
                    <div class="tt-node">${escapeHtml(n.node)}</div>
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
    .row { display: flex; align-items: center; height: 22px; }
    .row.edge.collapse { height: 0; }
    .row .art { flex: none; }
    .row.commit { cursor: pointer; position: relative; }
    .row.commit:hover { background: var(--vscode-list-hoverBackground); }
    .row.commit.selected {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
        height: auto;
    }
    .row.commit.selected > .art { align-self: flex-start; }
    .info { min-width: 0; padding: 0 8px 0 2px; }
    .title { display: flex; gap: 10px; align-items: baseline; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .title .author { opacity: .6; flex: none; }
    .title .desc { overflow: hidden; text-overflow: ellipsis; }
    /* Git-like rich hover: shown next to the row, never captures the mouse */
    .tooltip {
        display: none;
        position: absolute;
        left: var(--art-w, 40px);
        top: 0;
        z-index: 10;
        min-width: 240px; max-width: 460px;
        padding: 6px 10px;
        background: var(--vscode-editorHoverWidget-background, var(--vscode-editorWidget-background, #252526));
        color: var(--vscode-editorHoverWidget-foreground, var(--vscode-editorWidget-foreground, inherit));
        border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-editorWidget-border, #454545));
        border-radius: 3px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, .35);
        pointer-events: none;
        white-space: normal;
    }
    .row.commit:hover > .tooltip { display: block; }
    .tt-title { font-weight: 600; }
    .tt-meta { opacity: .8; margin-top: 3px; }
    .tt-node { opacity: .5; font-size: 11px; margin-top: 3px; }
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
<div id="list" style="--art-w: ${artWidth}px">
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
        if (m && m.type === 'dump') {
            vscode.postMessage({ type: 'dump', html: document.getElementById('list').outerHTML });
        }
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

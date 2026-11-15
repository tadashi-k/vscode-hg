import * as vscode from 'vscode';
import { parseStatus, runHg } from './hg';

export interface GraphNode {
    rev: number;
    node: string;
    branch: string;
    user: string;
    date: string;
    desc: string;
}

export interface GraphRow {
    /** hg's ASCII graph art for this line (trimmed) */
    art: string;
    /** present for changeset rows, absent for pure edge lines */
    node?: GraphNode;
}

const DATA_MARKER = 'hgdata|';
const FIELD_SEP = '\x1f';

// hg's graph charset; everything before the data marker is art
const ART_CHARS = new Set(['o', '@', 'x', '|', '/', '\\', '+', ':', '.', '_', ' ']);

function looksLikeArt(line: string): boolean {
    const t = line.trimEnd();
    if (!t) { return true; }
    for (const c of t) {
        if (!ART_CHARS.has(c)) { return false; }
    }
    return true;
}

/**
 * Fetch the Mercurial history as an ASCII graph.
 * `hg log -G` prints the graph art on every line; changeset lines carry our
 * template output (prefixed by a marker so we can split art from data even
 * when descriptions contain graph-like characters).
 */
export async function fetchGraph(
    hgPath: string,
    root: string,
    limit: number
): Promise<GraphRow[]> {
    const template = `${DATA_MARKER}{rev}${FIELD_SEP}{node|short}${FIELD_SEP}{branch}${FIELD_SEP}{author|user}${FIELD_SEP}{date|shortdate}${FIELD_SEP}{desc|firstline}`;

    const out = await runHg(hgPath, root, [
        '--encoding', 'utf-8',
        'log', '-G', '-l', String(limit), '--template', template
    ]);

    const rows: GraphRow[] = [];
    for (const line of out.split('\n')) {
        if (!line.trim()) { continue; }
        const markerIdx = line.indexOf(DATA_MARKER);
        if (markerIdx >= 0) {
            const art = line.slice(0, markerIdx).trimEnd();
            const fields = line.slice(markerIdx + DATA_MARKER.length).split(FIELD_SEP);
            rows.push({
                art,
                node: {
                    rev: parseInt(fields[0], 10),
                    node: fields[1] ?? '',
                    branch: fields[2] || 'default',
                    user: fields[3] ?? '',
                    date: fields[4] ?? '',
                    desc: fields[5] ?? ''
                }
            });
        } else if (looksLikeArt(line)) {
            rows.push({ art: line.trimEnd() });
        } else {
            // unexpected output (warnings etc.) - skip
        }
    }
    return rows;
}

export interface ChangesetFile {
    status: string; // M, A, R ...
    path: string;
}

/** Files changed by one changeset (`hg status --change <node>`) */
export async function fetchChangesetFiles(
    hgPath: string,
    root: string,
    node: string
): Promise<ChangesetFile[]> {
    const out = await runHg(hgPath, root, ['--encoding', 'utf-8', 'status', '--change', node]);
    return parseStatus(out).map(s => ({ status: s.code, path: s.path }));
}

const PALETTE = ['#4fc1ff', '#b180d7', '#f19f39', '#6cd9cc', '#e06c75', '#98c379'];

export function colorAt(col: number): string {
    return PALETTE[((col % PALETTE.length) + PALETTE.length) % PALETTE.length];
}

/**
 * Render one row of `hg log -G` art as SVG elements, styled like the
 * built-in Git graph: lanes run continuously and branch/merge edges are
 * smooth S-curves. Geometry: char at index i occupies column i;
 * x-center = (i + 0.5) * COL_W. The art is drawn inside a row of height
 * `height` shifted down by `yOffset` (icons center it in a square box).
 */
export function artSvgElements(
    art: string,
    isCommit: boolean,
    height: number,
    yOffset: number,
    colW = 11
): string {
    const parts: string[] = [];
    const x = (i: number): number => (i + 0.5) * colW;
    const W = '2';
    const NODE_R = 5;

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
                parts.push(`<line x1="${xi}" y1="${yOffset}" x2="${xi}" y2="${yOffset + height}" stroke="${color}" stroke-width="${W}"/>`);
                break;
            case '\\': {
                // edge moves from column i-1 (top) to column i (bottom),
                // drawn as a smooth S-curve like Git
                const x1 = x(i - 1);
                parts.push(`<path d="M ${x1} ${yOffset} Q ${(x1 + xi) / 2} ${yOffset + height / 2} ${xi} ${yOffset + height}" stroke="${color}" stroke-width="${W}" fill="none"/>`);
                break;
            }
            case '/': {
                // edge moves from column i (top) to column i-1 (bottom)
                const x2 = x(i - 1);
                parts.push(`<path d="M ${xi} ${yOffset} Q ${(xi + x2) / 2} ${yOffset + height / 2} ${x2} ${yOffset + height}" stroke="${color}" stroke-width="${W}" fill="none"/>`);
                break;
            }
            case '_':
                parts.push(`<line x1="${xi}" y1="${yOffset + height / 2}" x2="${xi + colW}" y2="${yOffset + height / 2}" stroke="${color}" stroke-width="${W}"/>`);
                break;
            case 'o':
            case '@':
            case 'x': {
                // '@' marks the working-copy parent (the newest revision);
                // draw it as a hollow ring like Git draws the HEAD commit
                const r = c === '@' ? 6 : NODE_R;
                const cy = yOffset + height / 2;
                if (isCommit) {
                    parts.push(`<line x1="${xi}" y1="${yOffset}" x2="${xi}" y2="${cy - r}" stroke="${color}" stroke-width="${W}"/>`);
                    parts.push(`<line x1="${xi}" y1="${cy + r}" x2="${xi}" y2="${yOffset + height}" stroke="${color}" stroke-width="${W}"/>`);
                }
                if (c === '@') {
                    parts.push(`<circle cx="${xi}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="2"/>`);
                } else {
                    parts.push(`<circle cx="${xi}" cy="${cy}" r="${r}" fill="${color}"${c === 'x' ? ' fill-opacity="0.4"' : ''}/>`);
                }
                break;
            }
            default:
                break;
        }
    }
    return parts.join('');
}

/**
 * Icon for a tree row: a square 22x22 viewBox so it fills the tree's
 * 16x16 icon box and the node dot renders as a proper circle (like Git).
 * The art is clipped to the leftmost 2 lanes; all rows share the same
 * viewBox so nodes stay aligned across rows.
 */
export function rowIconUri(art: string, isCommit: boolean): vscode.Uri {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">'
        + artSvgElements(art.slice(0, 2), isCommit, 22, 0)
        + '</svg>';
    return vscode.Uri.parse('data:image/svg+xml;base64,' + Buffer.from(svg, 'utf8').toString('base64'));
}

export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

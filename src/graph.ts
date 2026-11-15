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

/** Convert `hg log -G` art into color-per-column HTML spans */
export function artToHtml(art: string): string {
    const palette = [
        'var(--hg-graph-c1)', 'var(--hg-graph-c2)', 'var(--hg-graph-c3)',
        'var(--hg-graph-c4)', 'var(--hg-graph-c5)', 'var(--hg-graph-c6)'
    ];
    let html = '';
    for (let i = 0; i < art.length; i++) {
        const c = art[i];
        if (c === ' ') {
            html += ' ';
            continue;
        }
        const color = palette[i % palette.length];
        if (c === 'o' || c === '@' || c === 'x') {
            html += `<span class="hg-node" style="color:${color}">&#9679;</span>`;
        } else {
            html += `<span style="color:${color}">${escapeHtml(c)}</span>`;
        }
    }
    return html;
}

export function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

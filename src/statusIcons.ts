import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * SVG letter badges for the SCM resource rows.
 *
 * VS Code renders an SCM resource's `iconPath` file icon at the RIGHT end
 * of the row (that is where the built-in Git extension shows its status
 * letters). A ThemeIcon, however, is rendered as a codicon glyph next to
 * the file name instead, so we generate SVG letter icons. The letter is
 * drawn in the status color without a background, matching the Graph
 * view's file-badge rendering (FileDecoration letters).
 */

// per theme, like git's icons/light + icons/dark badge variants
// letter colors, aligned with the hgDecoration.* theme colors used by
// the Graph view's file badges (see package.json contributes.colors)
const STATUS_COLORS: Record<string, { light: string; dark: string }> = {
    M: { light: '#9a7b00', dark: '#c9a53a' }, // modified: yellow
    A: { light: '#3c8746', dark: '#81b88b' }, // added: green
    R: { light: '#9e121d', dark: '#c74e59' }, // removed: red
    '!': { light: '#9e121d', dark: '#c74e59' }, // deleted from disk: red
    '?': { light: '#6c6c6c', dark: '#9d9d9d' }, // untracked: grey
    C: { light: '#969696', dark: '#969696' }    // clean: light grey
};

export type StatusIcons = Map<string, { light: vscode.Uri; dark: vscode.Uri }>;

/** file name base for a status code (avoid '!' in file names) */
function iconFileBase(code: string): string {
    switch (code) {
        case '!': return 'deleted';
        case '?': return 'untracked';
        default: return code.toLowerCase();
    }
}

/** one SVG badge: bare letter in the status color (no background),
 *  matching the Graph view's FileDecoration letter rendering */
export function svgBadge(letter: string, color: string): string {
    return [
        '<svg width="14px" height="14px" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">',
        '  <text x="50" y="80" font-size="100" text-anchor="middle" style="font-family: Menlo, Monaco, Consolas, &quot;Droid Sans Mono&quot;, monospace, &quot;Droid Sans Fallback&quot;;" fill="' + color + '">',
        `    ${letter}`,
        '  </text>',
        '</svg>'
    ].join('\n');
}

/**
 * Write one badge SVG per status code and theme into
 * globalStorage/status-icons/{light,dark} and return the map
 * code -> {light, dark} icon Uris for use as resource iconPath.
 */
export async function ensureStatusIcons(
    globalStorageUri: vscode.Uri
): Promise<StatusIcons> {
    const map: StatusIcons = new Map();
    for (const theme of ['light', 'dark'] as const) {
        const dir = path.join(globalStorageUri.fsPath, 'status-icons', theme);
        await fs.promises.mkdir(dir, { recursive: true });
        for (const [code, colors] of Object.entries(STATUS_COLORS)) {
            const letter = code === '!' ? 'D' : code;
            const file = path.join(dir, `${iconFileBase(code)}.svg`);
            await fs.promises.writeFile(file, svgBadge(letter, colors[theme]), 'utf8');
            const entry = map.get(code) ?? { light: vscode.Uri.file(file), dark: vscode.Uri.file(file) };
            entry[theme] = vscode.Uri.file(file);
            map.set(code, entry);
        }
    }
    return map;
}

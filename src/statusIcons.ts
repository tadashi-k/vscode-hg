import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Git-style SVG letter badges for the SCM resource rows.
 *
 * VS Code renders an SCM resource's `iconPath` file icon at the RIGHT end
 * of the row (that is how the built-in Git extension shows its M/A/D
 * badges: small colored rounded squares with a white letter, drawn as
 * SVG letter icons in the git extension's resources folder). A ThemeIcon, however,
 * is rendered as a codicon glyph next to the file name instead, so to get
 * git-like badges we generate the same kind of SVG letter icons.
 */

// per theme, like git's icons/light + icons/dark badge variants
const STATUS_COLORS: Record<string, { light: string; dark: string }> = {
    M: { light: '#9a7b00', dark: '#c9a53a' }, // modified: yellow
    A: { light: '#3c8746', dark: '#3c8746' }, // added: green (git's added badge)
    R: { light: '#9e121d', dark: '#9e121d' }, // removed: red (git's deleted badge)
    '!': { light: '#9e121d', dark: '#9e121d' }, // deleted from disk: red
    '?': { light: '#6c6c6c', dark: '#6c6c6c' }, // untracked: grey (git's untracked badge)
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

/** one SVG badge: rounded colored square + centered white letter */
export function svgBadge(letter: string, color: string): string {
    return [
        '<svg width="14px" height="14px" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">',
        `  <rect fill="${color}" x="0" y="0" width="100" height="100" rx="35" ry="35"/>`,
        '  <text x="50" y="75" font-size="75" text-anchor="middle" style="font-family: Menlo, Monaco, Consolas, &quot;Droid Sans Mono&quot;, monospace, &quot;Droid Sans Fallback&quot;;" fill="white">',
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

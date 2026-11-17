import * as vscode from 'vscode';

/**
 * File decorations for files listed under a commit in the Graph view.
 *
 * Graph file rows use a dedicated 'hg-file' URI scheme that carries the
 * change's status, so the badge reflects THAT commit's change (like Git's
 * graph: A for added-by-this-commit, M for modified-by-this-commit, ...),
 * not the current working-copy state.
 *
 * VS Code renders FileDecorations as colored letter badges at the RIGHT
 * end of TreeView rows - the same mechanism the Explorer uses - which is
 * what gives the Graph's changed-file rows git-style badges.
 */

/** status -> decoration theme color id (see contributes.colors) */
const DECORATION_COLORS: Record<string, string> = {
    M: 'hgDecoration.modifiedResourceForeground',
    A: 'hgDecoration.addedResourceForeground',
    R: 'hgDecoration.removedResourceForeground',
    '!': 'hgDecoration.deletedResourceForeground',
    '?': 'hgDecoration.untrackedResourceForeground'
};

/** URI for a file entry under a commit in the Graph view */
export function hgFileUri(relPath: string, status: string): vscode.Uri {
    return vscode.Uri.from({
        scheme: 'hg-file',
        path: `/${relPath.replace(/\\/g, '/')}`,
        query: status
    });
}

export class HgGraphFileDecorationProvider implements vscode.FileDecorationProvider {
    private readonly onDidChangeEmitter = new vscode.EventEmitter<undefined>();
    readonly onDidChangeFileDecorations: vscode.Event<undefined> = this.onDidChangeEmitter.event;

    provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
        if (uri.scheme !== 'hg-file') { return undefined; }
        const status = uri.query;
        const colorId = DECORATION_COLORS[status];
        if (!colorId) { return undefined; }
        const letter = status === '!' ? 'D' : status;
        return {
            badge: letter,
            color: new vscode.ThemeColor(colorId),
            tooltip: `${letter} (in this commit)`
        };
    }
}

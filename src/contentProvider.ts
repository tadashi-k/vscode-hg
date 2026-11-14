import * as path from 'path';
import * as vscode from 'vscode';
import { runHg } from './hg';

/**
 * Provides original file content ("hg:" scheme) so that VS Code's diff
 * editor can show working-tree changes against the parent revision.
 * URI format: hg://<repo-root>/<rel-path>?<revision>
 */
export class HgContentProvider implements vscode.TextDocumentContentProvider {
    constructor(private hgPath: string) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const rev = uri.query || '.';
        const repoRoot = uri.authority.replace(/\\/g, '/');
        const rel = path.posix.normalize(uri.path.replace(/\\/g, '/')).replace(/^\//, '');
        return await runHg(this.hgPath, repoRoot, ['cat', '-r', rev, '--', rel]);
    }
}

export function toHgUri(repoRoot: string, relPath: string, rev = '.'): vscode.Uri {
    const normalizedRoot = repoRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    return vscode.Uri.parse(`hg://${normalizedRoot}/${relPath}?${encodeURIComponent(rev)}`);
}

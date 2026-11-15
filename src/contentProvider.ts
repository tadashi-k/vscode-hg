import * as path from 'path';
import * as vscode from 'vscode';
import { runHg } from './hg';

/**
 * Provides original file content ("hg:" scheme) so that VS Code's diff
 * editor can show working-tree changes against a revision.
 *
 * URI layout (authority must NOT be used: VS Code parses custom schemes
 * like URLs, so a Windows drive path "C:/repo" would be mangled):
 *   scheme:  hg
 *   path:    /<repo-relative path>
 *   query:   base64url(repo root)
 *   fragment: revision (defaults to '.')
 */
export class HgContentProvider implements vscode.TextDocumentContentProvider {
    constructor(private hgPath: string) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        let root = '';
        try {
            root = Buffer.from(uri.query, 'base64url').toString('utf8');
        } catch {
            root = uri.query;
        }
        let rel = uri.path.replace(/^\//, '');
        try {
            rel = decodeURIComponent(rel);
        } catch { /* keep raw */ }
        const rev = uri.fragment || '.';

        if (!root || !rel) {
            throw new Error(`Invalid hg: URI (missing repo root or path): ${uri.toString()}`);
        }
        if (rev === 'null') {
            return ''; // the null revision has no content (added/removed file side)
        }
        // rev may be a revset expression like "p1(<node>)" - hg accepts those for -r
        return await runHg(this.hgPath, root, ['cat', '-r', rev, '--', rel.replace(/\\/g, '/')]);
    }
}

export function toHgUri(repoRoot: string, relPath: string, rev = '.'): vscode.Uri {
    return vscode.Uri.from({
        scheme: 'hg',
        path: `/${relPath.replace(/\\/g, '/')}`,
        query: Buffer.from(repoRoot, 'utf8').toString('base64url'),
        fragment: rev
    });
}

/** Relative repo path of an absolute file URI, or undefined if outside the repo */
export function relPathInRepo(repoRoot: string, fileUri: vscode.Uri): string | undefined {
    const rel = path.relative(repoRoot, fileUri.fsPath).replace(/\\/g, '/');
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return undefined;
    }
    return rel;
}

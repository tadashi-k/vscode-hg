import * as vscode from 'vscode';
import { runHg } from './hg';
import { toHgUri } from './contentProvider';

export async function showRevisionDetails(
    hgPath: string,
    root: string,
    rev: number,
    node: string
): Promise<void> {
    const log = await runHg(hgPath, root, ['--encoding', 'utf-8', 'log', '-v', '-r', node]);
    const doc = await vscode.workspace.openTextDocument({ content: log, language: 'plaintext' });
    await vscode.window.showTextDocument(doc, { preview: true });
    void rev;
}

export async function showRevisionDiff(
    hgPath: string,
    root: string,
    rev: number,
    node: string
): Promise<void> {
    const diff = await runHg(hgPath, root, ['--encoding', 'utf-8', 'diff', '-c', node]);
    const label = `Mercurial: changeset ${rev} (diff)`;
    if (diff.trim()) {
        const doc = await vscode.workspace.openTextDocument({ content: diff, language: 'diff' });
        await vscode.window.showTextDocument(doc, { preview: true });
    } else {
        vscode.window.showInformationMessage(`${label}: empty changeset`);
    }
}

/**
 * Diff a single file *at* a changeset: parent revision vs the changeset itself.
 * status handling: 'A' files get an empty original side, 'R' files an empty
 * modified side (the null revision).
 */
export async function showFileDiffAtRevision(
    hgPath: string,
    root: string,
    relPath: string,
    rev: number,
    node: string,
    status: string
): Promise<void> {
    const origRev = (status === 'A' || status === '?') ? 'null' : `p1(${node})`;
    const modRev = status === 'R' ? 'null' : node;
    const title = `${relPath} (r${rev}, ${status})`;
    await vscode.commands.executeCommand(
        'vscode.diff',
        toHgUri(root, relPath, origRev),
        toHgUri(root, relPath, modRev),
        title
    );
}

export async function updateToRevision(
    hgPath: string,
    root: string,
    rev: number
): Promise<void> {
    await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Mercurial: updating working directory' },
        () => runHg(hgPath, root, ['update', '-r', String(rev)])
    );
    vscode.window.showInformationMessage(`Mercurial: updated to r${rev}`);
}

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { HgStatus, parseStatus, runHg, showHgError } from './hg';
import { toHgUri } from './contentProvider';

export class HgRepository implements vscode.Disposable {
    readonly root: string;
    readonly repo: vscode.SourceControl;
    readonly workingGroup: vscode.SourceControlResourceGroup;
    readonly untrackedGroup: vscode.SourceControlResourceGroup;

    private branchItem: vscode.StatusBarItem;
    private disposables: vscode.Disposable[] = [];
    private watcher?: vscode.FileSystemWatcher;
    private timer?: NodeJS.Timeout;

    constructor(
        private readonly hgPath: string,
        rootUri: vscode.Uri,
        private readonly autoRefresh: boolean
    ) {
        this.root = rootUri.fsPath;

        this.repo = vscode.scm.createSourceControl('hg', 'Mercurial', rootUri);
        this.repo.acceptInputCommand = { command: 'hg.commit', title: 'Commit' };

        this.branchItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        this.branchItem.command = 'hg.log';
        this.disposables.push(this.branchItem);
        this.repo.statusBarCommands = [
            { command: 'hg.log', title: 'Mercurial: Show History' }
        ];

        this.workingGroup = this.repo.createResourceGroup('working', 'Changes');
        this.untrackedGroup = this.repo.createResourceGroup('untracked', 'Untracked Files');

        this.repo.inputBox.placeholder = 'Commit message (Mercurial)';

        if (this.autoRefresh) {
            const pattern = new vscode.RelativePattern(rootUri, '{.hg/store/**,*.py,*.js,*.ts,*.md,*.txt,*.json,*.rs,*.c,*.cpp,*.h,*.java,*.go,*.cs,*.html,*.css}');
            this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
            this.disposables.push(this.watcher);
            const onChange = () => this.scheduleRefresh();
            this.disposables.push(
                this.watcher.onDidChange(onChange),
                this.watcher.onDidCreate(onChange),
                this.watcher.onDidDelete(onChange)
            );
        }

        this.disposables.push(this.repo);
    }

    /** Absolute path for a repo-relative path */
    abs(rel: string): string {
        return path.join(this.root, rel);
    }

    async refresh(): Promise<void> {
        try {
            const [branch, statusOut] = await Promise.all([
                runHg(this.hgPath, this.root, ['branch']),
                runHg(this.hgPath, this.root, ['status', '-mardu'])
            ]);

            const b = branch.trim();
            this.branchItem.text = `$(git-branch) hg:${b || 'default'}`;
            this.branchItem.tooltip = `Mercurial branch: ${b || 'default'}\n${this.root}`;
            this.branchItem.show();

            const statuses = parseStatus(statusOut);
            this.workingGroup.resourceStates = statuses
                .filter(s => s.code !== '?')
                .map(s => this.toResourceState(s));
            this.untrackedGroup.resourceStates = statuses
                .filter(s => s.code === '?')
                .map(s => this.toResourceState(s));
            this.repo.count = statuses.length;
        } catch (err) {
            showHgError(err);
        }
    }

    private toResourceState(s: HgStatus): vscode.SourceControlResourceState {
        const fileUri = vscode.Uri.file(this.abs(s.path));
        const icon = {
            M: 'diff-modified',
            A: 'diff-added',
            R: 'diff-removed',
            '!': 'diff-removed',
            '?': 'new-file',
            C: 'circle-outline'
        }[s.code] ?? 'warning';

        return {
            resourceUri: fileUri,
            command: s.code !== '?' && s.code !== 'R'
                ? { command: 'hg.showDiff', title: 'Show Diff', arguments: [this, fileUri] }
                : undefined,
            decorations: {
                iconPath: new vscode.ThemeIcon(icon),
                strikeThrough: s.code === 'R' || s.code === '!',
                tooltip: `(${s.code}) ${s.path}`
            }
        };
    }

    scheduleRefresh(): void {
        if (this.timer) { clearTimeout(this.timer); }
        this.timer = setTimeout(() => { void this.refresh(); }, 500);
    }

    async commit(message: string, files?: vscode.Uri[]): Promise<void> {
        if (!message.trim()) {
            vscode.window.showWarningMessage('Mercurial: commit message is empty');
            return;
        }
        // include untracked files when committing everything, like the Git extension does
        if (!files || files.length === 0) {
            const untracked = this.untrackedGroup.resourceStates.map(s => path.relative(this.root, s.resourceUri.fsPath));
            if (untracked.length > 0) {
                await runHg(this.hgPath, this.root, ['add', '--', ...untracked]);
            }
        }
        const args = ['commit', '-m', message, '--quiet'];
        if (files && files.length > 0) {
            args.push(...files.map(u => u.fsPath));
        }
        try {
            await runHg(this.hgPath, this.root, args, { stdin: message });
            await this.refresh();
            this.repo.inputBox.value = '';
        } catch (err) {
            showHgError(err);
        }
    }

    async add(files: vscode.Uri[]): Promise<void> {
        const rels = files.map(u => path.relative(this.root, u.fsPath));
        try {
            await runHg(this.hgPath, this.root, ['add', '--', ...rels]);
            await this.refresh();
        } catch (err) {
            showHgError(err);
        }
    }

    async revert(files: vscode.Uri[]): Promise<void> {
        const rels = files.map(u => path.relative(this.root, u.fsPath));
        try {
            await runHg(this.hgPath, this.root, ['revert', '--no-backup', '--', ...rels]);
            await this.refresh();
        } catch (err) {
            showHgError(err);
        }
    }

    async clean(): Promise<void> {
        try {
            await runHg(this.hgPath, this.root, ['purge']);
            await this.refresh();
        } catch {
            // fall back: purge extension may not be enabled
            showHgError(new Error('hg purge failed. Is the "purge" extension enabled? Run: hg config extensions.purge='));
        }
    }

    async showLog(): Promise<void> {
        const log = await runHg(this.hgPath, this.root, ['log', '-l', '50', '--template', '{rev}  {node|short}  {author|user}  {date|isodate}  {branch}\n    {desc|firstline}\n\n']);
        const doc = await vscode.workspace.openTextDocument({ content: log, language: 'plaintext' });
        await vscode.window.showTextDocument(doc);
    }

    async showDiff(fileUri: vscode.Uri): Promise<void> {
        const rel = path.relative(this.root, fileUri.fsPath).replace(/\\/g, '/');
        const original = toHgUri(this.root, rel, '.');
        const title = `Mercurial: ${rel} (parent) ↔ working`;
        await vscode.commands.executeCommand('vscode.diff', original, fileUri, title);
    }

    static async detect(
        hgPath: string,
        folder: vscode.WorkspaceFolder,
        autoRefresh: boolean
    ): Promise<HgRepository | undefined> {
        try {
            await fs.promises.access(path.join(folder.uri.fsPath, '.hg'), fs.constants.F_OK);
        } catch {
            return undefined;
        }
        // verify hg is actually available
        try {
            await runHg(hgPath, folder.uri.fsPath, ['root']);
        } catch (err) {
            console.error(`[vscode-hg] hg not found for ${folder.uri.fsPath}:`, err);
            return undefined;
        }
        return new HgRepository(hgPath, folder.uri, autoRefresh);
    }

    dispose(): void {
        this.branchItem.hide();
        if (this.timer) { clearTimeout(this.timer); }
        for (const d of this.disposables) { d.dispose(); }
        this.disposables = [];
    }
}

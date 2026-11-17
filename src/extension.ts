import * as path from 'path';
import * as vscode from 'vscode';
import { runHg } from './hg';
import { HgAnnotateInlayHintsProvider } from './annotate';
import { HgContentProvider } from './contentProvider';
import { HgTreeItem, HgGraphTree } from './graphTree';
import { HgRepository } from './repository';
import { ensureStatusIcons } from './statusIcons';
import { HgGraphFileDecorationProvider } from './decorations';
import { showFileDiffAtRevision, showRevisionDetails, showRevisionDiff, updateToRevision } from './revisions';

export class HgExtension implements vscode.Disposable {
    private _repositories: HgRepository[] = [];
    private contentProvider?: vscode.Disposable;
    private annotateProvider?: HgAnnotateInlayHintsProvider;
    private annotateInlayDisposable?: vscode.Disposable;
    private graphTree?: HgGraphTree;
    private graphTreeView?: vscode.TreeView<vscode.TreeItem>;
    private hgPath = 'hg';
    private readonly changeEmitter = new vscode.EventEmitter<void>();
    /** Fired when repository state changes (commit, refresh, clean, ...) */
    readonly onDidChangeRepos = this.changeEmitter.event;

    private fireChange(): void {
        this.changeEmitter.fire();
    }

    async activate(context: vscode.ExtensionContext): Promise<void> {
        if (context.workspaceState.get('hg.enabled') === false) {
            return;
        }
        if (!vscode.workspace.isTrusted) {
            vscode.workspace.onDidGrantWorkspaceTrust(() => { void this.activate(context); });
            return;
        }

        const config = vscode.workspace.getConfiguration('hg');
        if (config.get<boolean>('enabled') === false) {
            return;
        }
        const hgPath = config.get<string>('path') || 'hg';
        this.hgPath = hgPath;
        const autoRefresh = config.get<boolean>('autoRefresh', true);

        this.contentProvider = vscode.workspace.registerTextDocumentContentProvider(
            'hg',
            new HgContentProvider(hgPath)
        );
        context.subscriptions.push(this.contentProvider);

        // colored status-letter badges at the right end of the Graph view's
        // changed-file rows, like the Git extension's graph
        const graphDecorations = new HgGraphFileDecorationProvider();
        // @types/vscode >= 1.146 moves registerFileDecorationProvider to
        // window; older runtimes (engine ^1.99) have it on workspace -
        // use whichever exists
        type DecorationRegistrar = (p: vscode.FileDecorationProvider) => vscode.Disposable;
        const registerDecoration: DecorationRegistrar | undefined =
            (vscode.window as unknown as { registerFileDecorationProvider?: DecorationRegistrar }).registerFileDecorationProvider
            ?? (vscode.workspace as unknown as { registerFileDecorationProvider?: DecorationRegistrar }).registerFileDecorationProvider;
        if (registerDecoration) {
            context.subscriptions.push(registerDecoration(graphDecorations));
        } else {
            console.error('[vscode-hg] registerFileDecorationProvider not available; Graph badges disabled');
        }

        // annotate mode ("blame" beside line numbers)
        this.annotateProvider = new HgAnnotateInlayHintsProvider(
            hgPath,
            (uri: vscode.Uri) =>
                this._repositories.find(r => uri.fsPath.startsWith(r.root))?.root
        );
        // annotate mode defaults to OFF per editor; toggled via hg.annotate
        this.annotateInlayDisposable = vscode.languages.registerInlayHintsProvider(
            '*',
            this.annotateProvider
        );
        context.subscriptions.push(
            this.annotateInlayDisposable,
            this.createAnnotateRefreshListeners()
        );

        // generate git-style SVG letter badges once per session
        const statusIcons = await ensureStatusIcons(context.globalStorageUri);

        const folders = vscode.workspace.workspaceFolders ?? [];
        // "Graph" NATIVE tree view in the Source Control view container
        // (like the built-in Git extension's Source Control Graph)
        this.graphTree = new HgGraphTree(
            hgPath,
            () => this._repositories.map(r => r.root),
            cb => this.onDidChangeRepos(cb)
        );
        this.graphTreeView = vscode.window.createTreeView('hg.graph', {
            treeDataProvider: this.graphTree
        });
        this.graphTree.view = this.graphTreeView;
        context.subscriptions.push(this.graphTree, this.graphTreeView);

        for (const folder of folders) {
            const repo = await HgRepository.detect(hgPath, folder, autoRefresh, statusIcons);
            if (repo) {
                this._repositories.push(repo);
                context.subscriptions.push(repo);
                void repo.refresh();
            }
        }

        // watch for folder add/remove
        context.subscriptions.push(
            vscode.workspace.onDidChangeWorkspaceFolders(e => {
                for (const r of e.removed) {
                    this._repositories = this._repositories.filter(repo => {
                        if (repo.root.startsWith(r.uri.fsPath)) {
                            repo.dispose();
                            return false;
                        }
                        return true;
                    });
                }
                for (const a of e.added) {
                    void HgRepository.detect(hgPath, a, autoRefresh, statusIcons).then(repo => {
                        if (repo) {
                            this._repositories.push(repo);
                            context.subscriptions.push(repo);
                            void repo.refresh();
                        }
                    });
                }
                this.updateContext();
            })
        );

        void this.graphTree.refresh();
        this.updateContext();

        this.registerCommands(context);
    }

    private updateContext(): void {
        void vscode.commands.executeCommand(
            'setContext', 'hg.repoCount', this._repositories.length
        );
        this.updateAnnotateContext();
    }

    /** annotate toggle state of the ACTIVE editor, for the title-bar button */
    private updateAnnotateContext(): void {
        const uri = vscode.window.activeTextEditor?.document.uri;
        void vscode.commands.executeCommand(
            'setContext', 'hg.annotateEnabled',
            uri ? this.annotateProvider?.isEnabledFor(uri) === true : false
        );
    }

    /** Keep annotate hints fresh across editor switches, edits and commits */
    private createAnnotateRefreshListeners(): vscode.Disposable {
        const fire = () => { this.annotateProvider?.invalidate(); };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const debouncedFire = () => {
            clearTimeout(timer);
            timer = setTimeout(fire, 500);
        };
        return vscode.Disposable.from(
            vscode.window.onDidChangeActiveTextEditor(() => {
                this.updateAnnotateContext();
                fire();
            }),
            vscode.workspace.onDidChangeTextDocument(e => {
                if (!e.contentChanges.length) { return; }
                // debounce typing; refresh 500 ms after the last edit
                debouncedFire();
            }),
            this.onDidChangeRepos(fire)
        );
    }

    private registerCommands(context: vscode.ExtensionContext): void {
        const cmd = (id: string, fn: (...args: any[]) => unknown) =>
            context.subscriptions.push(
                vscode.commands.registerCommand(id, async (...args) => {
                    try {
                        await fn(...args);
                    } catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        if (!/nothing changed/i.test(msg)) {
                            vscode.window.showErrorMessage(`Mercurial: ${msg}`);
                        }
                    }
                })
            );

        // these commands serve both positional calls (tests, API) and
        // view/item/context menu calls (they receive a HgTreeItem)
        cmd('hg.showRevisionDetails', async (arg: unknown, rev?: number, node?: string) => {
            if (arg instanceof HgTreeItem && arg.data.kind === 'commit') {
                await showRevisionDetails(this.hgPath, arg.data.root, arg.data.rev, arg.data.node);
                return;
            }
            if (typeof arg === 'string' && rev !== undefined && node !== undefined) {
                await showRevisionDetails(this.hgPath, arg, rev, node);
            }
        });

        cmd('hg.showRevisionDiff', async (arg: unknown, rev?: number, node?: string) => {
            if (arg instanceof HgTreeItem && arg.data.kind === 'commit') {
                await showRevisionDiff(this.hgPath, arg.data.root, arg.data.rev, arg.data.node);
                return;
            }
            if (typeof arg === 'string' && rev !== undefined && node !== undefined) {
                await showRevisionDiff(this.hgPath, arg, rev, node);
            }
        });

        cmd('hg.showFileDiffAtRevision', (root: string, relPath: string, rev: number, node: string, status: string) =>
            showFileDiffAtRevision(this.hgPath, root, relPath, rev, node, status));

        cmd('hg.updateToRevision', async (arg: unknown, rev?: number) => {
            const root = arg instanceof HgTreeItem && arg.data.kind === 'commit'
                ? arg.data.root
                : arg;
            const target = arg instanceof HgTreeItem && arg.data.kind === 'commit'
                ? arg.data.rev
                : rev;
            if (typeof root !== 'string' || target === undefined) { return; }
            await updateToRevision(this.hgPath, root, target);
            await Promise.all(this._repositories.map(r => r.refresh()));
            this.fireChange();
        });

        cmd('hg.copyCommitHash', async (arg: unknown) => {
            const data = arg instanceof HgTreeItem && arg.data.kind === 'commit' ? arg.data : undefined;
            if (!data) { return; }
            await vscode.env.clipboard.writeText(data.node);
        });

        cmd('hg.copyCommitMessage', async (arg: unknown) => {
            const data = arg instanceof HgTreeItem && arg.data.kind === 'commit' ? arg.data : undefined;
            if (!data) { return; }
            // first line only, like Git's 'Copy Subject'
            const subject = data.desc.split('\n')[0].trim();
            await vscode.env.clipboard.writeText(subject);
        });

        // expand the newest commit in the Graph view (badge visual check)
        cmd('hg.graph.revealLatest', async () => {
            await this.graphTree?.revealLatestCommit();
        });

        // branch quick pick (row badge command / command palette)
        cmd('hg.checkoutBranch', async (...args) => {
            const repo = this.getRepo(args[0]);
            if (!repo) { return; }
            const current = (await runHg(this.hgPath, repo.root, ['branch'])).trim();
            const branches = (await runHg(this.hgPath, repo.root, ['branches']))
                .split('\n')
                .map(l => l.replace(/\s{2,}.*$/, '').trim())
                .filter(b => !!b);
            if (branches.length === 0) { return; }
            const pick = await vscode.window.showQuickPick(
                branches.map(b => ({
                    label: b === current ? `$(check) ${b}` : b,
                    branch: b
                })),
                { placeHolder: `Switch branch (current: ${current})` }
            );
            if (!pick || pick.branch === current) { return; }
            await runHg(this.hgPath, repo.root, ['update', '-r', pick.branch]);
            await Promise.all(this._repositories.map(r => r.refresh()));
            this.fireChange();
        });

        cmd('hg.refresh', async () => {
            await Promise.all(this._repositories.map(r => r.refresh()));
            this.fireChange();
        });

        cmd('hg.commit', async (...args) => {
            const repo = this.getRepo(args[0]);
            if (!repo) { return; }
            let message = '';
            let files: vscode.Uri[] | undefined;
            for (const arg of args) {
                if (typeof arg === 'string') { message = arg; }
                if (Array.isArray(arg) && arg[0] instanceof vscode.Uri) {
                    files = arg as vscode.Uri[];
                }
            }
            if (!message) {
                message = repo.repo.inputBox.value;
            }
            await repo.commit(message, files);
            this.fireChange();
        });

        cmd('hg.commitAll', async (...args) => {
            const repo = this.getRepo(args[0]);
            if (!repo) { return; }
            const message = repo.repo.inputBox.value;
            await repo.commit(message);
            this.fireChange();
        });

        cmd('hg.add', async (...args) => {
            const repo = this.getRepo(args[0]);
            const files = collectUris(args);
            if (!repo || files.length === 0) { return; }
            await repo.add(files);
            this.fireChange();
        });

        cmd('hg.revert', async (...args) => {
            const repo = this.getRepo(args[0]);
            const files = collectUris(args);
            if (!repo || files.length === 0) { return; }
            const answer = await vscode.window.showWarningMessage(
                'Revert selected changes? This cannot be undone.',
                { modal: true }, 'Revert'
            );
            if (answer === 'Revert') {
                await repo.revert(files);
                this.fireChange();
            }
        });

        cmd('hg.clean', async (...args) => {
            const repo = this.getRepo(args[0]);
            if (!repo) { return; }
            const answer = await vscode.window.showWarningMessage(
                'Delete all untracked files?',
                { modal: true }, 'Clean'
            );
            if (answer === 'Clean') {
                await repo.clean();
                this.fireChange();
            }
        });

        cmd('hg.deleteFile', async (...args) => {
            const uris = collectUris(args);
            if (uris.length === 0) { return; }
            const answer = await vscode.window.showWarningMessage(
                uris.length === 1
                    ? `Delete ${path.basename(uris[0].fsPath)}? This cannot be undone.`
                    : `Delete ${uris.length} files? This cannot be undone.`,
                { modal: true }, 'Delete'
            );
            if (answer !== 'Delete') { return; }
            for (const uri of uris) {
                await vscode.workspace.fs.delete(uri, { useTrash: false });
            }
            await Promise.all(this._repositories.map(r => r.refresh()));
            this.fireChange();
        });

        cmd('hg.annotate', async (resource: unknown) => {
            // editor/title buttons pass the document's URI as the first arg
            const uri = resource instanceof vscode.Uri
                ? resource
                : vscode.window.activeTextEditor?.document.uri;
            if (!uri || !this.annotateProvider) { return; }
            this.annotateProvider.toggleFor(uri);
            this.updateAnnotateContext();
        });

        cmd('hg.showDiff', async (...args) => {
            const repo = this.getRepo(args[0]);
            if (!repo) { return; }
            const uris = collectUris(args);
            const uri = uris[0]
                ?? vscode.window.activeTextEditor?.document.uri;
            if (!uri) { return; }
            await repo.showDiff(uri);
        });

        cmd('hg.openFile', async (...args) => {
            const uris = collectUris(args);
            for (const uri of uris) {
                await vscode.commands.executeCommand('vscode.open', uri);
            }
        });

    }

    /** Exposed as the extension's API (tests and other extensions can consume this) */
    repositories(): HgRepository[] {
        return this._repositories;
    }

    historyGraph(): HgGraphTree | undefined {
        return this.graphTree;
    }

    /** Resolve which repository a command targets (arg may be repo/group/resource) */
    private getRepo(arg: unknown): HgRepository | undefined {
        if (arg instanceof HgRepository) { return arg; }
        if (arg && typeof arg === 'object' && 'rootUri' in (arg as any)) {
            const root = (arg as { rootUri: vscode.Uri }).rootUri.fsPath;
            return this._repositories.find(r => root.startsWith(r.root));
        }
        if (arg instanceof vscode.Uri) {
            return this._repositories.find(r => arg.fsPath.startsWith(r.root));
        }
        return this._repositories[0];
    }

    dispose(): void {
        this.graphTreeView?.dispose();
        this.graphTree?.dispose();
        this.changeEmitter.dispose();
        for (const r of this._repositories) { r.dispose(); }
        this._repositories = [];
        this.contentProvider?.dispose();
    }
}

function collectUris(args: unknown[]): vscode.Uri[] {
    const out: vscode.Uri[] = [];
    for (const arg of args) {
        if (arg instanceof vscode.Uri) {
            out.push(arg);
        } else if (arg && typeof arg === 'object' && 'resourceUri' in (arg as any)) {
            const u = (arg as { resourceUri: vscode.Uri }).resourceUri;
            if (u instanceof vscode.Uri) { out.push(u); }
        } else if (Array.isArray(arg)) {
            out.push(...collectUris(arg));
        }
    }
    return out;
}

let extension: HgExtension | undefined;

export interface HgExtensionApi {
    repositories(): HgRepository[];
    /** The "Graph" native tree view in the Source Control area (rows()/changedFiles()) */
    historyGraph(): HgGraphTree | undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<HgExtensionApi> {
    extension = new HgExtension();
    context.subscriptions.push(extension);
    await extension.activate(context);
    return extension;
}

export function deactivate(): void {
    extension?.dispose();
    extension = undefined;
}

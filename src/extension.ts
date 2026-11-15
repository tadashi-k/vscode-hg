import * as vscode from 'vscode';
import { HgAnnotateInlayHintsProvider } from './annotate';
import { HgContentProvider } from './contentProvider';
import { HgGraphSidebar } from './graphSidebar';
import { HgRepository } from './repository';
import { showFileDiffAtRevision, showRevisionDetails, showRevisionDiff, updateToRevision } from './revisions';

export class HgExtension implements vscode.Disposable {
    private _repositories: HgRepository[] = [];
    private contentProvider?: vscode.Disposable;
    private annotateProvider?: HgAnnotateInlayHintsProvider;
    private annotateInlayDisposable?: vscode.Disposable;
    private graphSidebar?: HgGraphSidebar;
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

        const folders = vscode.workspace.workspaceFolders ?? [];
        // "Graph" webview view in the Source Control view container
        // (like the built-in Git extension's Source Control Graph)
        // NOTE: register the provider BEFORE repo detection so the view can
        // resolve as soon as it becomes visible
        this.graphSidebar = new HgGraphSidebar(
            hgPath,
            () => this._repositories.map(r => r.root),
            cb => this.onDidChangeRepos(cb)
        );
        context.subscriptions.push(
            this.graphSidebar,
            vscode.window.registerWebviewViewProvider(HgGraphSidebar.viewId, this.graphSidebar)
        );

        for (const folder of folders) {
            const repo = await HgRepository.detect(hgPath, folder, autoRefresh);
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
                    void HgRepository.detect(hgPath, a, autoRefresh).then(repo => {
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

        void this.graphSidebar.refresh();
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

        cmd('hg.showRevisionDetails', (root: string, rev: number, node: string) =>
            showRevisionDetails(this.hgPath, root, rev, node));

        cmd('hg.showRevisionDiff', (root: string, rev: number, node: string) =>
            showRevisionDiff(this.hgPath, root, rev, node));

        cmd('hg.showFileDiffAtRevision', (root: string, relPath: string, rev: number, node: string, status: string) =>
            showFileDiffAtRevision(this.hgPath, root, relPath, rev, node, status));

        cmd('hg.updateToRevision', async (root: string, rev: number) => {
            await updateToRevision(this.hgPath, root, rev);
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

    }

    /** Exposed as the extension's API (tests and other extensions can consume this) */
    repositories(): HgRepository[] {
        return this._repositories;
    }

    historyGraph(): HgGraphSidebar | undefined {
        return this.graphSidebar;
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
        this.graphSidebar?.dispose();
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
    /** The "Graph" webview view in the Source Control area (rows()/changedFiles()) */
    historyGraph(): HgGraphSidebar | undefined;
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

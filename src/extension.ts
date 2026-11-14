import * as vscode from 'vscode';
import { HgContentProvider } from './contentProvider';
import { HgRepository } from './repository';

export class HgExtension implements vscode.Disposable {
    private _repositories: HgRepository[] = [];
    private contentProvider?: vscode.Disposable;

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
        const autoRefresh = config.get<boolean>('autoRefresh', true);

        this.contentProvider = vscode.workspace.registerTextDocumentContentProvider(
            'hg',
            new HgContentProvider(hgPath)
        );
        context.subscriptions.push(this.contentProvider);

        const folders = vscode.workspace.workspaceFolders ?? [];
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
            })
        );

        this.registerCommands(context);
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

        cmd('hg.refresh', async () => {
            await Promise.all(this._repositories.map(r => r.refresh()));
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
        });

        cmd('hg.commitAll', async (...args) => {
            const repo = this.getRepo(args[0]);
            if (!repo) { return; }
            const message = repo.repo.inputBox.value;
            await repo.commit(message);
        });

        cmd('hg.add', async (...args) => {
            const repo = this.getRepo(args[0]);
            const files = collectUris(args);
            if (!repo || files.length === 0) { return; }
            await repo.add(files);
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
            }
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

        cmd('hg.log', async (...args) => {
            const repo = this.getRepo(args[0]);
            if (!repo) { return; }
            await repo.showLog();
        });
    }

    /** Exposed as the extension's API (tests and other extensions can consume this) */
    repositories(): HgRepository[] {
        return this._repositories;
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

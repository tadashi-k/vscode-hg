import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { HgExtensionApi } from '../extension';

const HG_TEST_ENV = process.env.HGRCPATH
    ? { ...process.env, HGRCPATH: process.env.HGRCPATH }
    : process.env;

let root: string;
let api: HgExtensionApi;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function changeNames(): string[] {
    return api.repositories()
        .flatMap(r => [...r.workingGroup.resourceStates, ...r.untrackedGroup.resourceStates])
        .map(r => path.basename(r.resourceUri.fsPath));
}

describe('vscode-hg extension', () => {
    before(async function () {
        this.timeout(30000);
        // dev extensions may get a different publisher id than package.json states
        const ext = vscode.extensions.all.find(e => e.id.endsWith('.vscode-hg'));
        if (!ext) {
            throw new Error(`vscode-hg extension not found, have: ${vscode.extensions.all.map(e => e.id).join(', ')}`);
        }
        api = await ext.activate();

        root = vscode.workspace.workspaceFolders![0].uri.fsPath;

        // deterministic dirty state: modify main.py, ensure untracked newfile.py
        fs.appendFileSync(path.join(root, 'main.py'), '// test-run change\n', 'utf8');
        if (!fs.existsSync(path.join(root, 'newfile.py'))) {
            fs.writeFileSync(path.join(root, 'newfile.py'), 'print("new file")\n', 'utf8');
        }
        execFileSync('hg', ['revert', '--no-backup', '--', 'main.py', 'README.md'],
            { cwd: root, env: HG_TEST_ENV, stdio: 'ignore' });
        fs.appendFileSync(path.join(root, 'main.py'), '// test-run change\n', 'utf8');

        await sleep(1500); // wait for detection + refresh
    });

    it('registers a Mercurial source control for the workspace', () => {
        const repos = api.repositories();
        if (repos.length !== 1) {
            throw new Error(`expected 1 repository, got ${repos.length}`);
        }
        if (!repos[0].root.startsWith(root)) {
            throw new Error(`repository root ${repos[0].root} does not match workspace ${root}`);
        }
    });

    it('detects modified and untracked files', () => {
        const names = changeNames();
        if (!names.includes('main.py')) {
            throw new Error(`main.py not in changes, got: ${names.join(', ')}`);
        }
        if (!names.includes('newfile.py')) {
            throw new Error(`newfile.py not in changes, got: ${names.join(', ')}`);
        }
    });

    it('shows branch information', () => {
        const statusOut = execFileSync('hg', ['branch'], { cwd: root, env: HG_TEST_ENV })
            .toString().trim();
        if (!statusOut) { throw new Error('hg branch returned nothing'); }
    });

    it('commits all changes via hg.commit', async function () {
        this.timeout(30000);
        await vscode.commands.executeCommand('hg.commit', 'test commit from integration test');
        await sleep(1500); // wait for post-commit refresh

        const names = changeNames();
        if (names.length !== 0) {
            throw new Error(`expected clean tree after commit, got: ${names.join(', ')}`);
        }
        const log = execFileSync('hg', ['log', '-l', '1', '--template', '{desc}'],
            { cwd: root, env: HG_TEST_ENV }).toString();
        if (!log.includes('test commit from integration test')) {
            throw new Error(`commit not found in log, got: ${log}`);
        }
    });

    after(function () {
        // re-create dirty state so manual testing keeps something to look at
        try {
            fs.appendFileSync(path.join(root, 'main.py'), '// test-run change\n', 'utf8');
        } catch { /* ignore */ }
        void api;
    });
});

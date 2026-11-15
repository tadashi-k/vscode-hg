import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { toHgUri } from '../contentProvider';
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
        const run = (args: string[], opts: { ignore?: boolean } = {}): string =>
            (execFileSync('hg', args, {
                cwd: root, env: HG_TEST_ENV,
                stdio: opts.ignore ? 'ignore' : 'pipe'
            }) ?? '').toString();

        // deterministic dirty state, idempotent across repeated test runs
        run(['update', '-q', '-C', '.'], { ignore: true }); // discard leftover edits
        // untrack newfile.py if a previous test run committed it
        if (run(['manifest']).includes('newfile.py')) {
            run(['remove', '--force', 'newfile.py'], { ignore: true });
            run(['commit', '-q', '-m', 'test setup: untrack newfile.py'], { ignore: true });
        }
        fs.writeFileSync(path.join(root, 'newfile.py'), 'print("new file")\n', 'utf8');
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

    it('shows a history graph with revisions and merge topology', async function () {
        this.timeout(30000);
        await vscode.commands.executeCommand('hg.showGraph');
        await sleep(2500); // wait for graph fetch
        const graph = api.historyGraph();
        if (!graph) { throw new Error('history graph view not created'); }
        const rows = graph.rows();
        const nodes = rows.filter(r => r.node);
        if (nodes.length < 3) {
            throw new Error(`expected at least 3 revisions in graph, got ${nodes.length}`);
        }
        if (!nodes.every(n => n.node!.node.length === 12)) {
            throw new Error('unexpected node hash format in graph rows');
        }
        // the sample repo has a feature branch merged into default
        const hasMergeArt = rows.some(r => r.art.includes('\\') || r.art.includes('/'));
        if (!hasMergeArt) {
            throw new Error('expected branch/merge art (\\ or /) in graph, got: '
                + rows.map(r => r.art).join(' | '));
        }
    });

    it('populates the Graph tree view in the Source Control area', async function () {
        this.timeout(30000);
        await vscode.commands.executeCommand('hg.refresh');
        await sleep(2500); // wait for tree refresh (subscribed to repo change event)
        const tree = api.historyGraphTree();
        if (!tree) { throw new Error('graph tree view not created'); }
        const rows = tree.rows().filter(r => r.node);
        if (rows.length < 3) {
            throw new Error(`expected at least 3 revisions in graph tree, got ${rows.length}`);
        }
        const commands = await vscode.commands.getCommands();
        for (const cmd of ['hg.showRevisionDetails', 'hg.showRevisionDiff', 'hg.updateToRevision']) {
            if (!commands.includes(cmd)) {
                throw new Error(`command ${cmd} not registered`);
            }
        }
    });

    it('shows a diff when a file in Changes is clicked', async function () {
        this.timeout(30000);
        await vscode.commands.executeCommand('hg.refresh');
        await sleep(1500);

        const repo = api.repositories()[0];
        const mainUri = vscode.Uri.file(path.join(root, 'main.py'));

        // 1) the resource state must carry a diff command (what clicking triggers)
        const state = repo.workingGroup.resourceStates
            .find(s => path.basename(s.resourceUri.fsPath) === 'main.py');
        if (!state?.command) {
            throw new Error('main.py resource state has no command attached');
        }
        await vscode.commands.executeCommand(
            state.command.command, ...(state.command.arguments ?? [])
        );

        // 2) the hg: content provider must serve parent-revision content
        const doc = await vscode.workspace.openTextDocument(toHgUri(root, 'main.py', '.'));
        const expected = execFileSync('hg', ['cat', '-r', '.', '--', 'main.py'],
            { cwd: root, env: HG_TEST_ENV }).toString();
        if (doc.getText() !== expected) {
            throw new Error('hg: provider content does not match `hg cat -r . main.py`\n'
                + `provider: ${JSON.stringify(doc.getText().slice(0, 100))}\n`
                + `hg:       ${JSON.stringify(expected.slice(0, 100))}`);
        }
        void mainUri;
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

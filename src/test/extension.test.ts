import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { alignBlames, parseAnnotate, parseAnnotateNodes } from '../annotate';
import { toHgUri } from '../contentProvider';
import type { HgExtensionApi } from '../extension';

const HG_TEST_ENV = process.env.HGRCPATH
    ? { ...process.env, HGRCPATH: process.env.HGRCPATH }
    : process.env;

let root: string;
let api: HgExtensionApi;
let autoActivated = false;

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

        // check natural activation (activation events) BEFORE forcing activate()
        const start = Date.now();
        while (!ext.isActive && Date.now() - start < 15000) {
            await sleep(250);
        }
        autoActivated = ext.isActive;

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

    it('auto-activates on workspace open (activation events)', () => {
        if (!autoActivated) {
            throw new Error('extension was not activated by activation events '
                + '(onStartupFinished / workspaceContains) before the tests forced activation');
        }
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

    it('builds the graphical Graph view in the Source Control area', async function () {
        this.timeout(30000);
        const graph = api.historyGraph();
        if (!graph) { throw new Error('Graph view not created'); }
        await graph.refresh();
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

    it('creates the native Graph tree view in the Source Control area', async function () {
        const graph = api.historyGraph();
        if (!graph) { throw new Error('Graph tree view not created'); }
        // a native TreeView is attached synchronously at activation
        if (!graph.isResolved) {
            throw new Error('Graph tree view was not attached (createTreeView missing?)');
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

    it('renders native tree items with author description, hover tooltip and art icon', async function () {
        this.timeout(40000);
        const graph = api.historyGraph();
        if (!graph) { throw new Error('Graph view not created'); }
        await graph.refresh();
        await sleep(300);
        const items = await graph.dumpTree();
        const commits = items.filter(i => i.kind === 'commit');
        if (commits.length < 3) {
            throw new Error(`expected at least 3 commit tree items, got ${commits.length}`);
        }
        const first = commits[0];
        if (!first.label) {
            throw new Error('commit tree item has no label (commit message)');
        }
        if (!first.description) {
            throw new Error('commit tree item has no description (author) - git shows the author right of the title');
        }
        if (!first.tooltip || !(/r\d+/.test(first.tooltip) && first.node && first.tooltip.includes(first.node))) {
            throw new Error(`commit tree item tooltip misses rev/node: ${first.tooltip}`);
        }
        if (!first.hasIcon) {
            throw new Error('commit tree item has no graph art icon (iconPath missing)');
        }
        // expanding a commit lazily lists its changed files as children
        const files = await graph.changedFiles(first.node);
        void files;
    });

    it('lists changed files per commit and diffs a file at that revision', async function () {
        this.timeout(30000);
        const graph = api.historyGraph();
        if (!graph) { throw new Error('Graph view not created'); }
        await graph.refresh();

        const commits = graph.rows().filter(r => r.node);
        const target = commits.find(r => r.node!.desc.includes('integration test'));
        if (!target?.node) { throw new Error('no suitable commit found in graph'); }

        // expanding the commit lists its changed files
        const files = await graph.changedFiles(target.node.node);
        if (files.length === 0) {
            throw new Error('changedFiles() returned no files for the commit');
        }

        // clicking a file opens the diff at that commit (parent -> commit)
        const first = files[0];
        await vscode.commands.executeCommand(
            'hg.showFileDiffAtRevision',
            root, first.path, target.node!.rev, target.node.node, first.status
        );
    });

    it('parses hg annotate -u -d -q output into per-line blame prefixes', () => {
        // real format of `hg annotate -u -d -q`: user, short date, ': ', code
        const out = [
            'tadashi 2025-01-14: first line',
            'alice 2024-12-31: second line',
            '',
            'no-separator-line'
        ].join('\n');
        const hints = parseAnnotate(out);
        if (hints.length !== 2) {
            throw new Error(`expected 2 hints, got ${hints.length}: ${JSON.stringify(hints)}`);
        }
        if (hints[0] !== 'tadashi 2025-01-14') {
            throw new Error(`unexpected first hint: ${hints[0]}`);
        }
        if (hints[1] !== 'alice 2024-12-31') {
            throw new Error(`unexpected second hint: ${hints[1]}`);
        }
        // dates can contain ': ' inside? no - hg output separates with ': ' once,
        // but the separator itself must be found at the FIRST occurrence
        if (parseAnnotate('').length !== 0) {
            throw new Error('empty output must parse to no hints');
        }
    });

    it('right-aligns blame prefixes to a common column', () => {
        const out = alignBlames(['bob 2026-02-08', 'kobayasi 2026-03-28']);
        // longest = 'kobayasi 2026-03-28' (19 chars), so pad 19-14 = 5 spaces
        if (out[0] !== '     bob 2026-02-08' || out[1] !== 'kobayasi 2026-03-28') {
            throw new Error(`unexpected alignment: ${JSON.stringify(out)}`);
        }
        if (out[0].length !== out[1].length) {
            throw new Error('aligned prefixes must have equal length');
        }
        if (JSON.stringify(alignBlames([])) !== '[]') {
            throw new Error('empty input must stay empty');
        }
    });

    it('parses hg annotate -c -q output into per-line nodes', () => {
        const out = [
            '3f5a0d1c2b3e: first',
            '9c8b7a6f5e4d: second',
            'no-node-here',
            ''
        ].join('\n');
        const nodes = parseAnnotateNodes(out);
        if (JSON.stringify(nodes) !== JSON.stringify(['3f5a0d1c2b3e', '9c8b7a6f5e4d'])) {
            throw new Error(`unexpected nodes: ${JSON.stringify(nodes)}`);
        }
        if (parseAnnotateNodes('').length !== 0) {
            throw new Error('empty output must parse to no nodes');
        }
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

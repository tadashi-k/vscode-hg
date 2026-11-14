import { defineConfig } from '@vscode/test-cli';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));

// sample Mercurial repository opened as the test workspace
const testRepo = process.env.HG_TEST_REPO ?? path.resolve(here, '../hg-example-repo');

export default defineConfig({
    files: 'out/test/**/*.test.js',
    workspaceFolder: testRepo,
    // don't let other installed extensions interfere
    disableExtensions: true,
    mocha: { ui: 'bdd' },
    // hg needs a username to commit
    env: {
        HGRCPATH: process.env.HGRCPATH ?? path.join(path.dirname(testRepo), '.hg-test-hgrc')
    }
});

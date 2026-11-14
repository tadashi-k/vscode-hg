# vscode-hg

Mercurial source control integration for VS Code, providing an experience
similar to the built-in Git extension.

## Features

- Source Control view with **Changes** and **Untracked Files** groups
- Commit via the SCM input box (all or selected files)
- Add untracked files, revert changes, purge untracked files (`hg purge`)
- Inline diff against the parent revision (`hg diff`-style view)
- Show repository history (`hg log`)
- Branch name in the SCM view label
- Automatic refresh on file changes

## Requirements

- Mercurial (`hg`) on your PATH, or set `hg.path` in settings
- VS Code 1.99+

## Development

```bash
npm install
npm run compile
```

Then press **F5** in VS Code to launch an Extension Development Host with the
extension loaded. Open a folder containing a Mercurial repository.

## Testing

### Manual testing (F5)

1. Open this project in VS Code, press **F5** (launches an Extension
   Development Host with the extension loaded)
2. Open a Mercurial repository in the dev host, e.g. the sample repo at
   `../hg-example-repo` (regenerate with: `hg init`, commit something,
   then modify a file and create an untracked one)
3. Check the Source Control view, the status-bar branch indicator,
   and try committing, diffing, adding, and reverting files

### Automated integration tests

Tests run the extension inside a real VS Code instance (downloaded to
`.vscode-test/`) with the sample repo opened as the workspace:

```bash
npm test          # compiles, then runs vscode-test
npx vscode-test   # without recompiling
```

Config lives in `.vscode-test.mjs` (tests in `src/test/`, sample repo at
`../hg-example-repo`, mocha BDD ui, `HGRCPATH` pointing to
`../.hg-test-hgrc` so commits can run). The tests verify SCM registration,
status detection (modified + untracked), branch info, and end-to-end commit
through the `hg.commit` command.

Note: dev extensions can get a different publisher id than the one in
package.json, so tests look the extension up by name suffix (`.vscode-hg`)
and use the API the extension returns from `activate()`.

## Building a VSIX

```bash
npx @vscode/vsce package
```

## Current limitations (roadmap toward full Git-parity)

- Single root repository per workspace folder (multi-root works folder-wise)
- No shelve, uncommit, rebase, or bookmarks UI yet
- No push/pull or phase handling
- History view is a plain text document, not a graph view

## Configuration

| Setting | Default | Description |
| ------- | ------- | ----------- |
| `hg.enabled` | `true` | Enable/disable the integration |
| `hg.path` | `"hg"` | Path to the hg executable |
| `hg.autoRefresh` | `true` | Refresh status automatically on file changes |

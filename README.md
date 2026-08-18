# pi-file-diff

<p align="center">
  <strong>Task-end file-change receipts and an interactive diff viewer for Pi Coding Agent.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-file-diff"><img src="https://img.shields.io/npm/v/pi-file-diff?color=cb3837&label=npm" alt="npm version"></a>
  <a href="https://pi.dev/packages/pi-file-diff"><img src="https://img.shields.io/badge/Pi-Package%20Catalog-7c3aed" alt="Pi Package Catalog"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-22c55e" alt="MIT license"></a>
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh-CN.md">简体中文</a>
</p>

`pi-file-diff` gives every Pi task a compact, reviewable receipt: which files changed, how many lines were added or removed, and—when you need it—the exact per-file diff in a terminal-native panel. It works in ordinary directories as well as Git repositories.

```bash
pi install npm:pi-file-diff
```

## Table of contents

- [What it is](#what-it-is)
- [Why it exists](#why-it-exists)
- [How it compares](#how-it-compares)
- [Install](#install)
- [Demo](#demo)
- [Commands and controls](#commands-and-controls)
- [Configuration](#configuration)
- [How tracking works](#how-tracking-works)
- [Development](#development)

## What it is

Pi agents can edit files through `write` and `edit`, or indirectly through shell commands. `pi-file-diff` records those changes over a conversation and presents them in two layers:

1. **Automatic task receipt** — when a user-visible task fully settles, Pi receives one concise file list with aggregate `+/-` counts. Retries, compaction retries, and queued follow-ups are merged into the same receipt instead of producing overlapping summaries.
2. **Interactive review panel** — press <kbd>Ctrl</kbd>+<kbd>Q</kbd> on a receipt to browse every changed file. Use a dedicated diff gutter, line numbers, paging, keyboard navigation, and mouse-wheel scrolling to inspect the full patch without leaving the terminal.

The extension is intentionally display-only: summaries are appended as TUI entries and are not injected back into the model context.

## Why it exists

The answer to “what did the agent actually change?” is often scattered across tool calls, shell output, and Git status. That is inconvenient when:

- the workspace is not a Git repository;
- the agent changed files outside the repository, such as a temporary configuration file;
- a task involved several tool calls, retries, or follow-up runs;
- you want a quick receipt first and a diff only when something deserves review.

`pi-file-diff` is built around that hand-off moment. It provides a low-noise task-end summary by default, then lets you drill into the affected file when you choose.

## How it compares

These extensions solve adjacent, rather than identical, problems. Pick the surface that fits your workflow; they may be useful together.

| Need | `pi-file-diff` | [`@slix/pi-file-tracker`](https://pi.dev/packages/%40slix/pi-file-tracker) | [`@geminixiang/pi-diff`](https://pi.dev/packages/%40geminixiang/pi-diff) | [`@kkskcs/pi-diff-inline`](https://pi.dev/packages/%40kkskcs/pi-diff-inline) |
| --- | --- | --- | --- | --- |
| Primary surface | Task-end receipt + terminal diff panel | Persistent live widget above the input | Browser-based Git diff dashboard | Inline diff renderer in the conversation |
| Main unit of work | A settled task, with conversation history available on demand | Files touched during a live session | Working tree, staged, and commit diffs | A supplied diff or text comparison |
| Requires a Git repository | No. Git metadata is optional grouping information only. | No | Yes—its `/diff` command wraps Git diffs | No |
| Review interaction | Paginated full-screen TUI with keyboard and wheel navigation | Live status and file statistics | Browser review workflow and comments | Inline unified or split rendering |
| Best fit | “Show me one reliable receipt when this task is done.” | “Keep a running file-activity widget visible.” | “Review Git changes in a browser.” | “Render a diff block directly in chat.” |

The comparison reflects each package’s public Pi Catalog documentation as of this release; their feature sets can evolve independently.

## Install

### From npm — recommended

```bash
pi install npm:pi-file-diff
```

If Pi is already running, run `/reload`; otherwise restart Pi. To remove it later:

```bash
pi remove npm:pi-file-diff
```

### From a local checkout — development

From an existing local checkout:

```bash
cd /path/to/pi-file-diff
npm install
pi install "$(pwd)"
```

The npm package is the supported installation path for normal use.

## Demo

Screenshots are intentionally reserved here so the README keeps a stable layout while demos are being prepared. Add the supplied image files to [`docs/images/`](docs/images/README.md) with the names below; the matching Markdown snippets are ready to uncomment.

### 1. Task-end receipt

> **Screenshot placeholder:** `docs/images/task-receipt.png` — show the compact summary after a task with several changed files.

<!--
<p align="center">
  <img src="docs/images/task-receipt.png" alt="pi-file-diff task-end receipt" width="900">
</p>
-->

### 2. File browser

> **Screenshot placeholder:** `docs/images/file-browser.png` — show the <kbd>Ctrl</kbd>+<kbd>Q</kbd> list view, paging, and tracked/untracked grouping when available.

<!--
<p align="center">
  <img src="docs/images/file-browser.png" alt="pi-file-diff file browser" width="900">
</p>
-->

### 3. Per-file diff

> **Screenshot placeholder:** `docs/images/per-file-diff.png` — show line numbers and the separate `+`/`-` gutter in the diff view.

<!--
<p align="center">
  <img src="docs/images/per-file-diff.png" alt="pi-file-diff per-file diff view" width="900">
</p>
-->

## Commands and controls

| Command or key | What it does | Example |
| --- | --- | --- |
| Automatic receipt | Adds one summary after a task fully settles, but only when the task changed files. | Run an agent task normally. |
| `/file-diff` | Re-open the full change list accumulated by the current conversation. | `/file-diff` |
| `/file-diff-mode` | Inspect or switch shell-change tracking without editing JSON by hand. The choice is persisted. | `/file-diff-mode status`<br>`/file-diff-mode off` |
| `/file-diff-exclude` | Exclude a file or directory from future summaries. Supports relative paths, absolute paths, and `~`; path arguments support <kbd>Tab</kbd> completion. | `/file-diff-exclude .pi-dock/sessions`<br>`/file-diff-exclude remove .pi-dock/sessions` |
| <kbd>Ctrl</kbd>+<kbd>Q</kbd> | Open the per-file diff panel from a receipt. | On any `pi-file-diff` receipt. |
| <kbd>↑</kbd>/<kbd>↓</kbd>, <kbd>j</kbd>/<kbd>k</kbd>, mouse wheel | Move between files, or scroll the diff after opening one. | In the panel. |
| <kbd>Enter</kbd> | Open a selected file’s diff; in the diff view, close the panel. | In the panel. |
| <kbd>Esc</kbd> | Return from the diff to the list, or close the list. | In the panel. |

> Pi reserves <kbd>Ctrl</kbd>+<kbd>O</kbd> for its built-in tool-output folding shortcut, so this extension deliberately uses <kbd>Ctrl</kbd>+<kbd>Q</kbd>.

## Configuration

Create or edit `~/.pi/agent/file-diff.json`, then run `/reload` or restart Pi:

```json
{
  "lang": "en",
  "bashTracking": "auto",
  "bashThreshold": 200000,
  "ignore": ["my_vendor"],
  "exclude": [".pi-dock/sessions"]
}
```

| Setting | Values | Default | Meaning |
| --- | --- | --- | --- |
| `lang` | `en`, `zh` | `en` | UI language. |
| `bashTracking` | `auto`, `on`, `off` | `auto` | Whether to scan for shell-made changes. `auto` disables the scan when the workspace exceeds the threshold. |
| `bashThreshold` | positive integer | `200000` | Workspace-file threshold used by `auto` mode. |
| `ignore` | string array | `[]` | Additional directory-name ignore rules, case-insensitive. |
| `exclude` | string array | `[]` | File or directory paths to omit from tracking and summaries. |

`PI_FILE_DIFF_LANG` and `PI_FILE_DIFF_BASH_TRACKING` environment variables override the configuration file.

## How tracking works

| Change source | Detection | Review result |
| --- | --- | --- |
| Pi `edit` tool | Pi’s unified patch result | Exact patch and line counts. |
| Pi `write` tool | Path and written content | New-file content or tracked write result with counts. |
| Shell / `bash` tool | A bounded workspace snapshot plus an end-of-task scan | Text-file diff when the baseline is available; otherwise a path-level shell-change entry. |

Some intentional boundaries keep the extension responsive:

- Shell scanning is limited to the workspace and skips common dependency, build, VCS, cache, and IDE directories.
- Text snapshots are bounded by file size and total content limits. Large, binary, unreadable, or out-of-bound files may be represented without a textual diff.
- A concurrently edited file whose timestamp falls inside the task window can be attributed to shell activity.

## Development

Requirements: Node.js `>= 22.18.0` and npm.

```bash
npm install
npm run typecheck
npm test
```

## Contributing

Bug reports and focused pull requests are welcome. For UI changes, include a terminal screenshot or a test that demonstrates the behavior. Before opening a pull request, run:

```bash
npm run typecheck && npm test
```

## License

[MIT](LICENSE) © 2026 pi-file-diff contributors.

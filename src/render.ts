/**
 * pi-file-diff — Pure payload building and text rendering.
 *
 * No pi imports here on purpose: this module is unit-testable without a pi
 * runtime. The pi entry/panel renderers live in renderer.ts / diffviewer.ts.
 *
 * Directory aggregation: changed files are grouped by their path into a tree
 * rooted at the working directory. A subdirectory of the cwd whose subtree
 * holds >= `threshold` changed files collapses into a single directory entry
 * (the cwd itself is never aggregated). A directory's status reflects the
 * directory itself: new (not present at run start) → A, deleted → D,
 * otherwise → M, regardless of whether its changed files were added,
 * deleted, or modified. Without directory baseline info (no runSeen) it
 * falls back to merging child statuses.
 */

import { isAbsolute } from "node:path";
import type { TrackedChange } from "./tracker.ts";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { enMessages, type Messages } from "./i18n.ts";

export type EntryStatus = "A" | "M" | "D";
export type EntrySource = "shell" | "shell-modified";

/**
 * One node of the change tree. Directory nodes carry their raw children for
 * step-wise expansion in the interactive panel; file nodes carry the tracked
 * change for diff rendering. Summary payloads strip both (see SummaryEntry).
 */
export interface EntryNode {
  kind: "dir" | "file";
  /** Display path (dirs without trailing slash) */
  path: string;
  status: EntryStatus;
  insertions: number;
  deletions: number;
  /** Changed files in the subtree (1 for a file entry) */
  fileCount: number;
  /** Uniform source marker; undefined when mixed or none */
  source?: EntrySource;
  /** True for shell changes without a computable diff (binary, too large, snapshot missing) */
  noDiff?: boolean;
  /** git: true = all tracked, false = all untracked, undefined = mixed / no git info */
  tracked?: boolean;
  /** dir only — raw children (uncollapsed) */
  children?: EntryNode[];
  /** dir only — changed-file counts per status, for the composition marker */
  counts?: Record<EntryStatus, number>;
  /** file only */
  change?: TrackedChange;
}

/** Summary payload entry = tree entry minus diff/child payloads. */
export type SummaryEntry = Omit<EntryNode, "children" | "change">;

export interface SummaryPayload {
  entries: SummaryEntry[];
  totalFiles: number;
  totalInsertions: number;
  totalDeletions: number;
}

/** Max files shown in the summary entry (overflow collapses to "... and N more"). */
export const MAX_FILES = 10;

/** Max diff lines rendered per file inside the interactive panel. */
export const MAX_DIFF_LINES = 500;

export function isSummaryPayload(value: unknown): value is SummaryPayload {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return Array.isArray(obj.entries) && typeof obj.totalFiles === "number";
}

/** Split a unified patch into display lines, dropping ---/+++ headers and
 *  jsdiff's Index:/==== decoration lines. */
export function splitPatchLines(
  patch: string,
  maxLines: number,
): { lines: string[]; remaining: number } {
  const raw = patch
    .split("\n")
    .filter(
      (l) =>
        !l.startsWith("--- ") &&
        !l.startsWith("+++ ") &&
        !l.startsWith("Index: ") &&
        !l.startsWith("="),
    );
  while (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  return { lines: raw.slice(0, maxLines), remaining: Math.max(0, raw.length - maxLines) };
}

/** Split file content into display lines (trailing blanks dropped). */
export function splitContentLines(content: string, maxLines: number): { lines: string[]; remaining: number } {
  const raw = content.split("\n");
  while (raw.length > 0 && raw[raw.length - 1] === "") raw.pop();
  return { lines: raw.slice(0, maxLines), remaining: Math.max(0, raw.length - maxLines) };
}

/** Effective file-level status: resolved, else write ⇒ A, else M. */
export function effectiveStatus(change: TrackedChange): EntryStatus {
  return change.fileStatus ?? (change.kind === "write" ? "A" : "M");
}

/** Per-file source marker: shell-only or shell-modified after edit/write. */
function fileSource(change: TrackedChange): EntrySource | undefined {
  if (change.shellTouched) return "shell-modified";
  return change.kind === "bash" ? "shell" : undefined;
}

/** True for display paths that do not live under the cwd (never aggregated). */
function isOutsideWorkspace(displayPath: string): boolean {
  return isAbsolute(displayPath) || displayPath.startsWith("..");
}

interface RawNode {
  kind: "dir" | "file";
  path: string;
  status: EntryStatus;
  insertions: number;
  deletions: number;
  fileCount: number;
  source?: EntrySource;
  noDiff?: boolean;
  tracked?: boolean;
  children: RawNode[];
  counts?: Record<EntryStatus, number>;
  change?: TrackedChange;
}

/**
 * Build the change tree (bottom-up merged) from display-path items.
 * Root children only — the cwd itself never becomes an entry. Files outside
 * the cwd (absolute or `../`-escaped display paths) stay root-level file
 * entries, since only cwd subdirectories may aggregate.
 */
export function buildChangeTree(
  items: readonly {
    path: string;
    status: EntryStatus;
    change: TrackedChange;
    tracked?: boolean;
  }[],
  dirStatuses?: ReadonlyMap<string, EntryStatus>,
): EntryNode[] {
  const root: RawNode = {
    kind: "dir",
    path: "",
    status: "M",
    insertions: 0,
    deletions: 0,
    fileCount: 0,
    children: [],
  };

  const addFile = (parent: RawNode, item: (typeof items)[number]): void => {
    parent.children.push({
      kind: "file",
      path: item.path,
      status: item.status,
      insertions: item.change.insertions,
      deletions: item.change.deletions,
      fileCount: 1,
      source: fileSource(item.change),
      noDiff: item.change.kind === "bash" && item.change.bashDiff === undefined,
      tracked: item.tracked,
      children: [],
      change: item.change,
    });
  };

  for (const item of items) {
    if (isOutsideWorkspace(item.path)) {
      addFile(root, item);
      continue;
    }
    const segments = item.path.split(/[\\/]/).filter((s) => s.length > 0);
    let dir = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i]!;
      const childPath = dir.path === "" ? seg : dir.path + "/" + seg;
      let child = dir.children.find((c) => c.kind === "dir" && c.path === childPath) as
        | RawNode
        | undefined;
      if (!child) {
        child = {
          kind: "dir",
          path: childPath,
          status: "M",
          insertions: 0,
          deletions: 0,
          fileCount: 0,
          children: [],
        };
        dir.children.push(child);
      }
      dir = child;
    }
    addFile(dir, item);
  }

  finalize(root, dirStatuses);
  return root.children as EntryNode[];
}

/** Merge child stats into a directory node (post-order).
 *
 * `dirStatuses` (keyed by dir path) carries the baseline-verified directory
 * status when available; otherwise directory status is derived from the
 * children (all added → A, all deleted → D, else M).
 */
function finalize(node: RawNode, dirStatuses?: ReadonlyMap<string, EntryStatus>): void {
  if (node.kind === "file") return;
  for (const child of node.children) finalize(child, dirStatuses);
  node.insertions = node.children.reduce((s, c) => s + c.insertions, 0);
  node.deletions = node.children.reduce((s, c) => s + c.deletions, 0);
  node.fileCount = node.children.reduce((s, c) => s + c.fileCount, 0);

  const resolved = dirStatuses?.get(node.path);
  node.counts = dirChildCounts(node);
  if (resolved !== undefined) {
    node.status = resolved;
  } else {
    const statuses = new Set(node.children.map((c) => c.status));
    node.status =
      statuses.size === 1
        ? statuses.has("A")
          ? "A"
          : statuses.has("D")
            ? "D"
            : "M"
        : "M";
  }
  const sources = node.children
    .map((c) => c.source)
    .filter((s): s is EntrySource => s !== undefined);
  node.source = new Set(sources).size === 1 ? sources[0] : undefined;
  const tracked = node.children
    .map((c) => c.tracked)
    .filter((t): t is boolean => t !== undefined);
  node.tracked = new Set(tracked).size === 1 ? tracked[0] : undefined;
}

/**
 * Flatten one level of a tree into display entries: a directory whose subtree
 * holds >= `threshold` changed files stays a single entry; smaller directories
 * are unwrapped (recursively) into their files.
 */
export function collapseEntries(nodes: readonly EntryNode[], threshold: number): EntryNode[] {
  const out: EntryNode[] = [];
  for (const node of nodes) {
    if (node.kind === "file") {
      out.push(node);
    } else if (node.fileCount >= threshold) {
      out.push(node);
    } else {
      out.push(...collapseEntries(node.children ?? [], threshold));
    }
  }
  return out;
}

/** Drop diff bodies / child trees — safe for session entry payloads. */
function stripEntry(node: EntryNode): SummaryEntry {
  const { children: _children, change: _change, ...rest } = node;
  return rest;
}

/**
 * Build the summary payload from tracked changes.
 *
 * Contains only aggregated display entries — diff bodies stay in the
 * in-memory tracker and are shown by the interactive panel, keeping session
 * entries small. Returns null when nothing changed.
 *
 * `tracked` is the Set from detectTrackedFiles() (or null when the workspace
 * is not a git repo); it only classifies entries for grouped display.
 */
export function buildPayload(
  changes: readonly TrackedChange[],
  displayPath: (abs: string) => string,
  tracked: Set<string> | null = null,
  excludePaths?: ReadonlySet<string>,
  threshold = 5,
  dirStatuses?: ReadonlyMap<string, EntryStatus>,
): SummaryPayload | null {
  const filtered =
    excludePaths !== undefined
      ? changes.filter((c) => {
          for (const p of excludePaths) {
            if (c.path === p || c.path.startsWith(p + "/")) return false;
          }
          return true;
        })
      : changes;
  if (filtered.length === 0) return null;

  const tree = buildChangeTree(
    filtered.map((c) => {
      const display = displayPath(c.path);
      return {
        path: display,
        status: effectiveStatus(c),
        change: c,
        tracked: tracked !== null ? tracked.has(display) : undefined,
      };
    }),
    dirStatuses,
  );
  const entries = collapseEntries(tree, threshold).map(stripEntry);

  return {
    entries,
    totalFiles: filtered.length,
    totalInsertions: filtered.reduce((sum, c) => sum + c.insertions, 0),
    totalDeletions: filtered.reduce((sum, c) => sum + c.deletions, 0),
  };
}

export type ThemeColorName = "success" | "error" | "warning" | "muted" | "dim" | "accent";
/** Full theme color type — success is overridden to a fixed green at runtime. */
export type ColorFn = (color: ThemeColor, text: string) => string;

const idColor: ColorFn = (_color, text) => text;

/** ANSI strikethrough for deleted files. */
const STRIKE_ON = "\x1b[9m";
const STRIKE_OFF = "\x1b[29m";

function iconFor(status: EntryStatus): { icon: string; color: ThemeColorName } {
  switch (status) {
    case "A":
      return { icon: "+", color: "success" };
    case "D":
      return { icon: "-", color: "error" };
    default:
      return { icon: "M", color: "warning" };
  }
}

/** File and directory entries share the same icon set: + added, - deleted, M modified. */
function dirIconFor(status: EntryStatus): { icon: string; color: ThemeColorName } {
  return iconFor(status);
}

function renderCounts(
  entry: { insertions: number; deletions: number },
  fg: ColorFn,
): string[] {
  const counts: string[] = [];
  if (entry.insertions > 0) counts.push(fg("success", `+${entry.insertions}`));
  if (entry.deletions > 0) counts.push(fg("error", `-${entry.deletions}`));
  return counts.length > 0 ? ["  ", counts.join(" ")] : [];
}

function renderSource(entry: { source?: EntrySource }, fg: ColorFn, msgs: Messages): string[] {
  if (entry.source === "shell") return [fg("dim", msgs.shellMarker)];
  if (entry.source === "shell-modified") return [fg("dim", msgs.shellTouchedMarker)];
  return [];
}

/** Render one file line (icon + path + counts + shell markers). */
export function renderFileLine(
  f: {
    path: string;
    status: EntryStatus;
    insertions: number;
    deletions: number;
    source?: EntrySource;
    noDiff?: boolean;
  },
  fg: ColorFn,
  msgs: Messages,
): string {
  const { icon, color } = iconFor(f.status);
  const pathText = f.status === "D" ? STRIKE_ON + f.path + STRIKE_OFF : f.path;
  const parts: string[] = [fg(color, icon), " ", fg("dim", pathText)];
  parts.push(...renderCounts(f, fg));
  parts.push(...renderSource(f, fg, msgs));
  if (f.noDiff) parts.push(fg("dim", msgs.noDiffMarker));
  if (f.status === "A") parts.push(fg("dim", msgs.newFileMarker));
  else if (f.status === "D") parts.push(fg("dim", msgs.deletedFileMarker));
  return parts.join("");
}

/** Render one directory entry line (icon + dir path + aggregate counts + markers).
 *
 * The trailing marker is a composition of the subtree's file statuses:
 * `(N files added, N files deleted, N files modified)` — zero entries are
 * omitted.
 */
export function renderDirLine(
  d: {
    path: string;
    status: EntryStatus;
    insertions: number;
    deletions: number;
    fileCount: number;
    source?: EntrySource;
    children?: readonly EntryNode[];
    counts?: Record<EntryStatus, number>;
  },
  fg: ColorFn,
  msgs: Messages,
): string {
  const { icon, color } = dirIconFor(d.status);
  const pathText = d.status === "D" ? STRIKE_ON + d.path + "/" + STRIKE_OFF : d.path + "/";
  const parts: string[] = [fg(color, icon), " ", fg("dim", pathText)];
  parts.push(...renderCounts(d, fg));
  parts.push(...renderSource(d, fg, msgs));
  parts.push(fg("dim", msgs.dirComposition(d.counts ?? dirChildCounts(d))));
  return parts.join("");
}

/** Count the changed files under a subtree by their status. */
export function dirChildCounts(node: {
  children?: readonly { status: EntryStatus; fileCount: number }[];
}): Record<EntryStatus, number> {
  const counts: Record<EntryStatus, number> = { A: 0, D: 0, M: 0 };
  for (const child of node.children ?? []) counts[child.status] += child.fileCount;
  return counts;
}

/** Render one summary entry line (dir or file). */
export function renderEntryLine(
  entry: SummaryEntry | EntryNode,
  fg: ColorFn,
  msgs: Messages,
): string {
  return entry.kind === "dir"
    ? renderDirLine(entry, fg, msgs)
    : renderFileLine(entry, fg, msgs);
}

/**
 * Render the summary as colored text lines — aggregated entries only, no diff
 * bodies. When git tracking info is present, entries are grouped into tracked
 * and untracked sections. `fg` is injectable for tests; pi passes theme.fg.
 */
export function buildSummaryText(
  payload: SummaryPayload,
  fg: ColorFn = idColor,
  msgs: Messages = enMessages,
): string[] {
  const lines: string[] = [];

  const header: string[] = [fg("muted", msgs.filesChanged(payload.totalFiles))];
  if (payload.totalInsertions > 0) header.push(fg("success", `+${payload.totalInsertions}`));
  if (payload.totalDeletions > 0) header.push(fg("error", `-${payload.totalDeletions}`));
  lines.push(header.join("  "));

  const shown = payload.entries.slice(0, MAX_FILES);
  const hasGitInfo = shown.some((e) => e.tracked !== undefined);

  if (!hasGitInfo) {
    for (const e of shown) lines.push(renderEntryLine(e, fg, msgs));
  } else {
    const tracked = shown.filter((e) => e.tracked === true);
    const untracked = shown.filter((e) => e.tracked !== true);

    if (tracked.length > 0) {
      lines.push(fg("muted", "git tracked files:"));
      for (const e of tracked) lines.push(renderEntryLine(e, fg, msgs));
    }
    if (untracked.length > 0) {
      if (tracked.length > 0) lines.push("");
      lines.push(fg("muted", "git untracked files:"));
      for (const e of untracked) lines.push(renderEntryLine(e, fg, msgs));
    }
  }

  lines.push(fg("accent", msgs.summaryHintKey) + fg("dim", msgs.summaryHintRest));

  const shownFiles = shown.reduce((sum, e) => sum + e.fileCount, 0);
  const remaining = payload.totalFiles - shownFiles;
  if (remaining > 0) {
    lines.push(fg("dim", `... and ${remaining} more`));
  }
  if (payload.totalFiles > MAX_FILES) {
    lines.push(fg("warning", msgs.excludeHint));
  }

  return lines;
}

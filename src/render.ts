/**
 * pi-file-diff — Pure payload building and text rendering.
 *
 * No pi imports here on purpose: this module is unit-testable without a pi
 * runtime. The pi entry/panel renderers live in renderer.ts / diffviewer.ts.
 */

import type { ChangeKind, TrackedChange } from "./tracker.ts";
import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { enMessages, type Messages } from "./i18n.ts";

export interface SummaryFile {
  /** Display path (relative to cwd when inside, absolute otherwise) */
  file: string;
  /** A = whole file added, D = whole file deleted, M = content modified */
  status: "A" | "M" | "D";
  kind: ChangeKind;
  insertions: number;
  deletions: number;
  /** True when a shell command modified the file after the tracked op */
  shellTouched?: boolean;
  /** Git tracking status: true tracked, false untracked, undefined unknown */
  tracked?: boolean;
}

export interface SummaryPayload {
  files: SummaryFile[];
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
  return Array.isArray(obj.files) && typeof obj.totalFiles === "number";
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

/**
 * Build the summary payload from tracked changes.
 *
 * Contains only the file list — diff bodies stay in the in-memory tracker
 * and are shown by the interactive panel, keeping session entries small.
 * Returns null when nothing changed.
 *
 * `tracked` is the Set from detectTrackedFiles() (or null when the workspace
 * is not a git repo); it only classifies files for grouped display.
 */
export function buildPayload(
  changes: readonly TrackedChange[],
  displayPath: (abs: string) => string,
  tracked: Set<string> | null = null,
  excludePaths?: ReadonlySet<string>,
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

  const files: SummaryFile[] = filtered.slice(0, MAX_FILES).map((c) => {
    const display = displayPath(c.path);
    const file: SummaryFile = {
      file: display,
      status: c.fileStatus ?? (c.kind === "write" ? "A" : "M"),
      kind: c.kind,
      insertions: c.insertions,
      deletions: c.deletions,
    };
    if (c.shellTouched) file.shellTouched = true;
    if (tracked !== null) file.tracked = tracked.has(display);
    return file;
  });

  return {
    files,
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

/** Render one file line (icon + path + counts + shell markers). */
function renderFileLine(
  f: SummaryFile,
  fg: ColorFn,
  msgs: Messages,
): string {
  const icon = f.status === "A" ? "+" : f.status === "D" ? "-" : "~";
  const iconColor: ThemeColorName = f.status === "A" ? "success" : f.status === "D" ? "error" : "warning";
  const pathText = f.status === "D" ? STRIKE_ON + f.file + STRIKE_OFF : f.file;
  const parts: string[] = [fg(iconColor, icon), " ", fg("dim", pathText)];

  const counts: string[] = [];
  if (f.insertions > 0) counts.push(fg("success", `+${f.insertions}`));
  if (f.deletions > 0) counts.push(fg("error", `-${f.deletions}`));
  if (counts.length > 0) parts.push("  ", counts.join(" "));
  if (f.kind === "bash") parts.push(fg("dim", msgs.shellMarker));
  else if (f.shellTouched) parts.push(fg("dim", msgs.shellTouchedMarker));
  if (f.status === "A") parts.push(fg("dim", msgs.newFileMarker));
  else if (f.status === "D") parts.push(fg("dim", msgs.deletedFileMarker));

  return parts.join("");
}

/**
 * Render the summary as colored text lines — file list only, no diff bodies.
 * When git tracking info is present, files are grouped into tracked and
 * untracked sections. `fg` is injectable for tests; pi passes theme.fg.
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

  const hasGitInfo = payload.files.some((f) => f.tracked !== undefined);

  if (!hasGitInfo) {
    for (const f of payload.files) lines.push(renderFileLine(f, fg, msgs));
  } else {
    const tracked = payload.files.filter((f) => f.tracked === true);
    const untracked = payload.files.filter((f) => f.tracked !== true);

    if (tracked.length > 0) {
      lines.push(fg("muted", "git tracked files:"));
      for (const f of tracked) lines.push(renderFileLine(f, fg, msgs));
    }
    if (untracked.length > 0) {
      if (tracked.length > 0) lines.push("");
      lines.push(fg("muted", "git untracked files:"));
      for (const f of untracked) lines.push(renderFileLine(f, fg, msgs));
    }
  }

  lines.push(fg("dim", msgs.summaryHint));

  if (payload.totalFiles > MAX_FILES) {
    lines.push(fg("dim", `... and ${payload.totalFiles - MAX_FILES} more`));
    lines.push(fg("warning", msgs.excludeHint));
  }

  return lines;
}

/**
 * pi-file-diff — Change accumulation without git.
 *
 * Tracks file mutations from tool results (edit/write carry enough info to
 * reconstruct diffs: edit results include a standard unified patch, write
 * results include the full new content). Shell-driven mutations are caught
 * with a stat-only workspace scan at summary time (paths only, no diff).
 */

import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import { readTextFile } from "./snapshot.ts";

export type ChangeKind = "edit" | "write" | "bash";

export interface TrackedChange {
  /** Absolute path of the touched file */
  path: string;
  kind: ChangeKind;
  /** Concatenated unified patches (edit tool), capped at MAX_PATCH_CHARS */
  patch?: string;
  /** Last content for write kind, capped at MAX_CONTENT_CHARS */
  content?: string;
  contentTruncated?: boolean;
  /** Total line count of the write content */
  lineCount?: number;
  insertions: number;
  deletions: number;
  /** First time the file was touched in this conversation */
  firstTouchedAt: number;
  /** Set when a shell command modified the file after it was edit/write tracked.
   *  The recorded patch/content is then known-incomplete. */
  shellTouched?: boolean;
  /** Unified diff for shell modifications (snapshot vs current), when computable. */
  bashDiff?: string;
  /** File-level status: A = whole file added, D = whole file deleted,
   *  M = content modified. Resolved from snapshot + disk state. */
  fileStatus?: "A" | "M" | "D";
  /** Latest known content (write content, post-edit read, or last bash
   *  scan) — the baseline for incremental bash diffs. */
  knownContent?: string;
}

export interface PatchStats {
  insertions: number;
  deletions: number;
}

/**
 * Default directory blacklist — dependency/install/build dirs that must not
 * count as project files. Matched case-insensitively against any path
 * segment. Users can append more via the `ignore` config field.
 */
export const DEFAULT_IGNORED_DIRS = new Set([
  // VCS
  ".git", ".hg", ".svn", ".bzr",
  // JS/TS ecosystem
  "node_modules", "bower_components", "jspm_packages", ".yarn", ".pnpm-store", ".pnp", ".npm",
  // Python
  "site-packages", "dist-packages", ".venv", "venv", ".env", "env", "__pycache__",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".nox", ".conda",
  // Java/JVM
  ".m2", ".gradle", ".ivy2", ".coursier", "gradle", "target", "build", "out",
  // Go / Rust / Ruby / PHP
  "vendor", "third_party", "third-party", ".bundle", "gems",
  // Dart/Flutter
  ".dart_tool", ".flutter-plugins",
  // Web framework build output
  ".next", ".nuxt", ".output", ".svelte-kit", ".angular", ".vercel", ".netlify",
  ".serverless", ".terraform", ".turbo", ".nx", ".parcel-cache", ".cache",
  // Test coverage / temp
  "coverage", ".coverage", ".nyc_output", "htmlcov",
  // IDE / OS
  ".idea", ".vscode", ".vs", "DerivedData", "Pods", "__MACOSX",
  // Haskell / Elm
  ".stack-work", ".cabal", "elm-stuff",
]);

/** Cap for accumulated patch text per file (keeps payloads bounded). */
export const MAX_PATCH_CHARS = 100_000;
/** Cap for stored write content per file. */
export const MAX_CONTENT_CHARS = 20_000;
/** Max files reported by a single bash-change scan. */
export const MAX_BASH_FILES = 100;
/** Max directories visited per scan. */
export const MAX_SCAN_DIRS = 2_000;
/** Workspace file-count threshold for auto mode bash tracking (3s budget). */
export const DEFAULT_BASH_THRESHOLD = 200_000;
/** Tolerance for coarse filesystem mtime resolution (ms). */
export const MTIME_GUARD_MS = 1_000;

/**
 * Count +/- lines in a unified patch, ignoring `+++`/`---` file headers.
 * `\ No newline at end of file` markers start with `\` and are not counted.
 */
export function parsePatchStats(patch: string): PatchStats {
  let insertions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) insertions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { insertions, deletions };
}

/** wc -l semantics: a trailing newline does not add a line. */
export function countLines(content: string): number {
  if (content.length === 0) return 0;
  const parts = content.split("\n");
  return parts[parts.length - 1] === "" ? parts.length - 1 : parts.length;
}

/** Append a patch to an existing one, respecting the char cap. */
function appendCapped(existing: string, next: string, cap: number): { patch: string; truncated: boolean } {
  const merged = existing + "\n" + next;
  if (merged.length <= cap) return { patch: merged, truncated: false };
  return { patch: merged.slice(0, cap), truncated: true };
}

/**
 * Accumulates per-file changes for one conversation (session).
 *
 * Paths coming from tool arguments may be absolute or relative to the
 * workspace cwd; both are normalized to absolute form on record.
 */
export class ChangeTracker {
  private readonly cwd: string;
  private readonly extraIgnore?: ReadonlySet<string>;
  private readonly changes = new Map<string, TrackedChange>();
  private mutationCount = 0;
  /** Absolute paths excluded from diff stats (dirs or files; live set). */
  private excludePaths: ReadonlySet<string> = new Set();

  /** Total number of recorded mutations (edit/write/bash/flag) — monotonic. */
  get mutations(): number {
    return this.mutationCount;
  }

  constructor(cwd: string, extraIgnore?: ReadonlySet<string>, excludePaths?: ReadonlySet<string>) {
    this.cwd = cwd;
    this.extraIgnore = extraIgnore;
    if (excludePaths) this.excludePaths = excludePaths;
  }

  /** Update the live exclusion set (dirs or files, absolute paths). */
  setExcludePaths(paths: ReadonlySet<string>): void {
    this.excludePaths = paths;
  }

  /** True when the absolute path is inside an excluded dir or is an excluded file. */
  isExcluded(abs: string): boolean {
    for (const p of this.excludePaths) {
      if (abs === p || abs.startsWith(p + "/")) return true;
    }
    return false;
  }

  /** Normalize a tool-provided path to an absolute path. */
  normalizePath(filePath: string): string {
    return isAbsolute(filePath) ? filePath : resolve(this.cwd, filePath);
  }

  /** Display path: relative to cwd when inside it, absolute otherwise. */
  displayPath(absPath: string): string {
    const rel = relative(this.cwd, absPath);
    return rel !== "" && !rel.startsWith("..") ? rel : absPath;
  }

  /**
   * All tracked changes. edit/write first (most actionable), shell-detected
   * last; within each group oldest-first, then by path.
   */
  get all(): TrackedChange[] {
    return [...this.changes.values()].sort((a, b) => {
      const ak = a.kind === "bash" ? 1 : 0;
      const bk = b.kind === "bash" ? 1 : 0;
      if (ak !== bk) return ak - bk;
      return a.firstTouchedAt - b.firstTouchedAt || a.path.localeCompare(b.path);
    });
  }

  get size(): number {
    return this.changes.size;
  }

  recordEdit(filePath: string, patch: string | undefined): void {
    if (!patch) return;
    const abs = this.normalizePath(filePath);
    if (this.isExcluded(abs)) return;
    this.mutationCount++;
    const existing = this.changes.get(abs);
    const stats = parsePatchStats(patch);

    if (existing?.kind === "edit") {
      const { patch: merged, truncated } = appendCapped(existing.patch ?? "", patch, MAX_PATCH_CHARS);
      existing.patch = merged;
      existing.insertions += stats.insertions;
      existing.deletions += stats.deletions;
      // A new edit makes any earlier shell diff stale — drop it so the view
      // falls back to the (now current) edit patch chain instead of showing
      // outdated bash content.
      existing.bashDiff = undefined;
      if (truncated) existing.contentTruncated = true; // reuse flag: patch overflow
      return;
    }

    this.changes.set(abs, {
      path: abs,
      kind: "edit",
      patch,
      insertions: stats.insertions,
      deletions: stats.deletions,
      firstTouchedAt: existing?.firstTouchedAt ?? Date.now(),
      // kind transitions must keep the baseline (write → edit: the file's
      // content is unchanged, only the tracking kind changes)
      knownContent: existing?.knownContent,
    });
  }

  recordWrite(filePath: string, content: string): void {
    const abs = this.normalizePath(filePath);
    if (this.isExcluded(abs)) return;
    this.mutationCount++;
    const lineCount = countLines(content);
    const existing = this.changes.get(abs);
    const truncated = content.length > MAX_CONTENT_CHARS;

    this.changes.set(abs, {
      path: abs,
      kind: "write",
      content: truncated ? content.slice(0, MAX_CONTENT_CHARS) : content,
      contentTruncated: truncated,
      lineCount,
      insertions: lineCount,
      deletions: 0,
      firstTouchedAt: existing?.firstTouchedAt ?? Date.now(),
      // knownContent intentionally NOT set here: the baseline refreshes at
      // END of run (refreshKnownContents), so tool writes inside the same
      // run stay part of the complete diff instead of becoming the baseline.
    });
  }

  /** Record a shell-detected change. */
  recordBash(absPath: string, bashDiff?: string, knownContent?: string): void {
    if (this.changes.has(absPath)) return;
    if (this.isExcluded(absPath)) return;
    this.mutationCount++;
    const stats = bashDiff ? parsePatchStats(bashDiff) : { insertions: 0, deletions: 0 };
    this.changes.set(absPath, {
      path: absPath,
      kind: "bash",
      bashDiff,
      insertions: stats.insertions,
      deletions: stats.deletions,
      firstTouchedAt: Date.now(),
      knownContent,
    });
  }

  /**
   * Refresh every tracked file's knownContent to its current on-disk state.
   * Called at the end of every run (not at tool time), so the baseline for
   * the NEXT run's bash diffs is "state at the end of the previous run" —
   * tool operations inside the current run stay visible in the full diff.
   */
  async refreshKnownContents(): Promise<void> {
    for (const existing of this.changes.values()) {
      const current = await readTextFile(existing.path);
      if (current !== undefined) existing.knownContent = current;
    }
  }

  clear(): void {
    this.changes.clear();
  }

  /**
   * Resolve file-level status (A/M/D) for every tracked change by comparing
   * the per-run file set (files that existed when THIS run started) with the
   * current disk state. stat-only; only touches already-tracked files.
   * Best effort.
   */
  async resolveFileStatuses(runSeen: Set<string> | null): Promise<void> {
    if (!runSeen) return;
    for (const c of this.changes.values()) {
      const existedInitially = runSeen.has(c.path);
      let existsNow = false;
      try {
        await stat(c.path);
        existsNow = true;
      } catch {
        // missing or unreadable — treat as gone
      }
      if (existedInitially && !existsNow) c.fileStatus = "D";
      else if (!existedInitially && existsNow) c.fileStatus = "A";
      else if (existedInitially && existsNow) c.fileStatus = "M";
      // neither existed initially nor now — leave undefined (kind default)
    }
  }

  /**
   * Scan the workspace for files modified by shell commands since `startTime`.
   * stat-only walk, then content is read only for files whose mtime moved.
   * Best effort — failures are swallowed.
   *
   * `toolContents` maps absolute paths to the content recorded right after
   * a write/edit tool finished. Files whose current content still equals
   * that value were not touched by a shell command afterwards, so they are
   * skipped (prevents the tool's own write from being flagged as a shell
   * modification).
   *
   * Files already tracked via edit/write are NOT skipped: if their mtime
   * moved inside the window, a shell command modified them after the tracked
   * operation, so they are flagged shellTouched and their diff is recomputed
   * from the conversation snapshot (the recorded patch is then incomplete).
   *
   * `snapshot` (from takeContentSnapshot) provides the old contents needed
   * to build real diffs; without it only paths are recorded.
   */
  async collectBashChanges(
    startTime: number,
    snapshot?: ReadonlyMap<string, string>,
    toolContents?: ReadonlyMap<string, string>,
  ): Promise<void> {
    if (!startTime) return;
    const onDisk = new Set<string>();

    await walkWorkspace(this.cwd, (abs) => {
      onDisk.add(abs);
    }, this.extraIgnore);

    let recorded = 0;
    for (const abs of onDisk) {
      if (recorded >= MAX_BASH_FILES) break;
      let mtimeMs: number;
      try {
        mtimeMs = (await stat(abs)).mtimeMs;
      } catch {
        continue; // vanished between walk and stat
      }
      if (mtimeMs + MTIME_GUARD_MS < startTime) continue;
      if (this.isExcluded(abs)) continue;
      const current = await readTextFile(abs);
      // Written by a write/edit tool and untouched since — not a shell change.
      // (A tool-written binary that can't be read back is conservatively
      // skipped too; plain binary files modified by shell still get a
      // path-only entry below.)
      if (toolContents?.has(abs) && current === undefined) continue;
      if (current !== undefined && toolContents?.get(abs) === current) continue;
      const existing = this.changes.get(abs);
      const patch =
        current === undefined ? undefined : this.buildShellDiff(abs, snapshot, current, existing?.knownContent);
      if (existing) {
        if (existing.kind === "bash") {
          // Already shell-tracked and modified again (e.g. created via bash
          // in run 1, appended via bash in run 3): refresh the diff and count
          // the mutation — but skip when the content did not actually change
          // (e.g. a manual /file-diff re-scan producing an identical patch).
          if (patch && patch !== existing.bashDiff) {
            existing.bashDiff = patch;
            const stats = parsePatchStats(patch);
            existing.insertions = stats.insertions;
            existing.deletions = stats.deletions;
            this.mutationCount++;
          }
          if (current !== undefined) existing.knownContent = current;
          continue;
        }
        this.mutationCount++;
        existing.shellTouched = true;
        if (patch) {
          existing.bashDiff = patch;
          const stats = parsePatchStats(patch);
          existing.insertions = stats.insertions;
          existing.deletions = stats.deletions;
        }
        if (current !== undefined) existing.knownContent = current;
      } else {
        this.recordBash(abs, patch, current);
        recorded++;
      }
    }

    // Deletions: files present in the snapshot but gone from disk were
    // removed by a shell command (readdir cannot list deleted files).
    if (snapshot) {
      for (const abs of snapshot.keys()) {
        if (recorded >= MAX_BASH_FILES) break;
        if (onDisk.has(abs) || this.changes.has(abs) || this.isExcluded(abs)) continue;
        this.recordBash(abs, createTwoFilesPatch(abs, abs, snapshot.get(abs)!, ""));
        recorded++;
      }
    }

    // Deletions of already-tracked files (incl. bash-created ones, which the
    // snapshot does not contain): refresh to an all-deleted diff when old
    // content is available, otherwise just flag it.
    for (const abs of this.changes.keys()) {
      if (recorded >= MAX_BASH_FILES) break;
      if (onDisk.has(abs) || this.isExcluded(abs)) continue;
      const existing = this.changes.get(abs)!;
      const old = existing.knownContent ?? snapshot?.get(abs);
      const patch = old !== undefined ? createTwoFilesPatch(abs, abs, old, "") : undefined;
      if (existing.kind === "bash") {
        // All-deleted diff (undefined when no old content) counts as a fresh
        // state; identical re-scans of an already-deleted file do not.
        if (patch !== existing.bashDiff) {
          existing.bashDiff = patch;
          const stats = patch ? parsePatchStats(patch) : { insertions: 0, deletions: 0 };
          existing.insertions = stats.insertions;
          existing.deletions = stats.deletions;
          this.mutationCount++;
        }
        continue;
      }
      // edit/write-tracked: count only when this is genuinely new info
      // (first shell flag, or a different diff) — repeated scans of an
      // already-deleted file must not re-count.
      const fresh = !existing.shellTouched || (patch !== undefined && patch !== existing.bashDiff);
      if (fresh) this.mutationCount++;
      existing.shellTouched = true;
      if (patch && patch !== existing.bashDiff) {
        existing.bashDiff = patch;
        const stats = parsePatchStats(patch);
        existing.insertions = stats.insertions;
        existing.deletions = stats.deletions;
      }
    }
  }

  /**
   * Unified diff of the file's latest known content vs its current content.
   * Incremental semantics: only the delta since the last observed state is
   * reported (mirrors how edit patches accumulate). Falls back to the
   * conversation snapshot, then to all-added when nothing is known.
   */
  private buildShellDiff(
    abs: string,
    snapshot: ReadonlyMap<string, string> | undefined,
    current: string,
    knownContent?: string,
  ): string | undefined {
    const old = knownContent ?? snapshot?.get(abs);
    if (old === undefined) {
      if (!snapshot) return undefined; // no baseline at all — cannot diff
      // In the snapshot's scope but never observed — brand-new file.
      return createTwoFilesPatch(abs, abs, "", current);
    }
    if (old === current) return undefined; // mtime moved but content identical
    return createTwoFilesPatch(abs, abs, old, current);
  }
}

/**
 * BFS over a directory tree, invoking onFile for regular files.
 * Skips DEFAULT_IGNORED_DIRS plus any extra ignore names (case-insensitive),
 * symlinked directories, and stops at MAX_SCAN_DIRS.
 */
export async function walkWorkspace(
  root: string,
  onFile: (abs: string) => void,
  extraIgnore?: ReadonlySet<string>,
): Promise<void> {
  const queue: string[] = [root];
  let dirs = 0;

  const isIgnored = (name: string): boolean => {
    const lower = name.toLowerCase();
    if (DEFAULT_IGNORED_DIRS.has(lower)) return true;
    return extraIgnore !== undefined && extraIgnore.has(lower);
  };

  while (queue.length > 0 && dirs < MAX_SCAN_DIRS) {
    const dir = queue.shift();
    if (!dir) break;
    dirs++;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable or missing — skip
    }

    for (const entry of entries) {
      if (isIgnored(entry.name)) continue;
      const abs = join(dir, entry.name);
      // withFileTypes entries report symlinks as isSymbolicLink(), never
      // isDirectory(), so symlinked dirs are skipped implicitly.
      if (entry.isDirectory()) {
        queue.push(abs);
      } else if (entry.isFile()) {
        onFile(abs);
      }
    }
  }
}

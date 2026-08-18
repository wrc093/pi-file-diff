/**
 * pi-file-diff — Content snapshot for shell-change diffing.
 *
 * The bash tool reports no per-file change info, and by the time a file's
 * mtime change is detected the old content is gone. To still produce diffs
 * for shell-modified files, we snapshot text file contents at conversation
 * start (bounded: text-only, size/file/total caps, ignored dirs skipped)
 * and diff against the current content when a change is detected.
 */

import { readFile } from "node:fs/promises";
import { walkWorkspace } from "./tracker.ts";

/** Skip files larger than this when snapshotting (no diff for those). */
export const MAX_SNAPSHOT_FILE_BYTES = 512 * 1024;
/** Total snapshot budget — beyond this, remaining files are skipped. */
export const MAX_SNAPSHOT_TOTAL_BYTES = 32 * 1024 * 1024;
/** Max files read into the snapshot — bounds runtime on huge projects. */
export const MAX_SNAPSHOT_FILES = 20_000;
/** readFile batch size (fs uses a small thread pool, so keep batches sane). */
const READ_BATCH = 256;

/** Quick binary sniff: NUL byte or invalid UTF-8 → not a text file. */
export function looksLikeText(buf: Buffer): boolean {
  if (buf.includes(0)) return false;
  try {
    // decode with fatal: true to reject invalid UTF-8
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the current content of a file for diffing.
 * Returns undefined when the file is missing, too large, or binary.
 */
export async function readTextFile(absPath: string): Promise<string | undefined> {
  let buf: Buffer;
  try {
    buf = await readFile(absPath);
  } catch {
    return undefined;
  }
  if (buf.length > MAX_SNAPSHOT_FILE_BYTES) return undefined;
  if (!looksLikeText(buf)) return undefined;
  return buf.toString("utf-8");
}

/**
 * Collect the set of all files under `cwd` (abs paths) — stat-only, no
 * content reads. Used as the per-run baseline for file-level status.
 */
export async function collectFileSet(
  cwd: string,
  extraIgnore?: ReadonlySet<string>,
): Promise<Set<string>> {
  const seen = new Set<string>();
  await walkWorkspace(cwd, (abs) => seen.add(abs), extraIgnore);
  return seen;
}

/**
 * Snapshot text file contents under `cwd`.
 * Best effort, bounded; failures are swallowed.
 *
 * Returns both the captured contents (abs path → content) and the set of
 * ALL files that existed at snapshot time (including ones skipped for size
 * or budget) — the seen set is what determines "file existed at
 * conversation start", contents are only needed for diffing.
 */
export async function takeContentSnapshot(
  cwd: string,
  extraIgnore?: ReadonlySet<string>,
): Promise<{ contents: Map<string, string>; seen: Set<string> }> {
  const contents = new Map<string, string>();
  const seen = new Set<string>();
  let budget = MAX_SNAPSHOT_TOTAL_BYTES;

  const files: string[] = [];
  await walkWorkspace(cwd, (abs) => files.push(abs), extraIgnore);
  for (const abs of files) seen.add(abs);

  // Read in bounded concurrent batches, stopping when the byte budget runs
  // out. Serial reads of tens of thousands of files are far too slow.
  const toRead = files.slice(0, MAX_SNAPSHOT_FILES);
  for (let i = 0; i < toRead.length && budget > 0; i += READ_BATCH) {
    const batch = toRead.slice(i, i + READ_BATCH);
    const results = await Promise.all(
      batch.map(async (abs): Promise<{ abs: string; buf: Buffer } | undefined> => {
        try {
          const buf = await readFile(abs);
          if (buf.length > MAX_SNAPSHOT_FILE_BYTES || !looksLikeText(buf)) return undefined;
          return { abs, buf };
        } catch {
          return undefined;
        }
      }),
    );
    for (const r of results) {
      if (!r || r.buf.length > budget) continue;
      contents.set(r.abs, r.buf.toString("utf-8"));
      budget -= r.buf.length;
    }
  }

  return { contents, seen };
}

/**
 * pi-file-diff — Git tracking detection.
 *
 * Optional, read-only: `git ls-files` is used only to classify each changed
 * file as git-tracked or untracked for display. Diff generation itself never
 * touches git. Returns null when the workspace is not a git repository (or
 * git is unavailable), in which case callers render a single group.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Max bytes of git ls-files output we accept (safety cap). */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * List paths tracked by git, relative to `cwd`.
 *
 * Returns a Set of paths, or null when `cwd` is not inside a git repository
 * or git cannot be run (never throws).
 */
export async function detectTrackedFiles(cwd: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileP("git", ["-C", cwd, "ls-files"], {
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 10_000,
    });
    return new Set(
      stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
  } catch {
    // Not a git repo (exit 128), git missing (ENOENT), or timeout — no info.
    return null;
  }
}

/**
 * Classify a changed file's display path as tracked/untracked.
 * Returns undefined when no git info is available (non-repo workspace).
 */
export function isTracked(
  tracked: Set<string> | null,
  displayPath: string,
): boolean | undefined {
  if (tracked === null) return undefined;
  return tracked.has(displayPath);
}

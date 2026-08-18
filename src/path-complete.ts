/**
 * pi-file-diff — Path completion for the exclude command.
 *
 * Pure-ish module (fs reads only) so it is unit-testable. Completions are
 * relative when the prefix is relative, absolute when it is absolute, with
 * `~` expanded. Directories get a trailing "/" so repeated Tab presses walk
 * deeper without typing.
 */

import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface PathCompletion {
  value: string;
  label: string;
}

/** Expand a leading ~/ to the home directory (absolute paths only). */
export function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** Resolve a user-supplied path to an absolute path (relative to cwd). */
export function resolveUserPath(p: string, cwd: string): string {
  const expanded = expandHome(p);
  return isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
}

/**
 * Complete a path prefix against the filesystem.
 * Returns up to `limit` matching entries (dirs first, with trailing "/").
 */
export function completePath(prefix: string, cwd: string, limit = 30): PathCompletion[] {
  const trimmed = prefix.trim();
  const expanded = expandHome(trimmed);

  const baseDir =
    expanded === "" || expanded.endsWith("/")
      ? expanded === ""
        ? cwd
        : expanded
      : dirname(expanded);
  const partial = expanded === "" || expanded.endsWith("/") ? "" : basename(expanded);
  const absBase = isAbsolute(baseDir) ? baseDir : resolve(cwd, baseDir);

  let entries;
  try {
    entries = readdirSync(absBase, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs: PathCompletion[] = [];
  const files: PathCompletion[] = [];
  for (const e of entries) {
    if (dirs.length + files.length >= limit) break;
    if (!e.name.startsWith(partial)) continue;
    const isDir = e.isDirectory();
    const display = join(baseDir, e.name) + (isDir ? "/" : "");
    const item: PathCompletion = { value: display, label: display + (isDir ? " (dir)" : "") };
    (isDir ? dirs : files).push(item);
  }
  return [...dirs, ...files];
}

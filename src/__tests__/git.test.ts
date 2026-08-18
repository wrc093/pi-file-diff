import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { detectTrackedFiles, isTracked } from "../git.ts";

const execFileP = promisify(execFile);

async function git(dir: string, ...args: string[]): Promise<void> {
  await execFileP("git", ["-C", dir, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
}

describe("detectTrackedFiles", () => {
  it("returns null for a non-git directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-git-"));
    try {
      assert.equal(await detectTrackedFiles(dir), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lists tracked files and excludes untracked ones", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-git-"));
    try {
      await git(dir, "init", "-q");
      await git(dir, "config", "user.name", "t");
      await git(dir, "config", "user.email", "t@t");
      await mkdir(join(dir, "src"));
      await writeFile(join(dir, "src", "a.ts"), "a");
      await writeFile(join(dir, "README.md"), "r");
      await git(dir, "add", ".");
      await git(dir, "commit", "-qm", "init");
      await writeFile(join(dir, "src", "a.ts"), "a2"); // modified tracked file
      await writeFile(join(dir, "gen.txt"), "new"); // untracked

      const tracked = await detectTrackedFiles(dir);
      assert.ok(tracked);
      assert.ok(tracked.has("src/a.ts")); // tracked even though modified
      assert.ok(tracked.has("README.md"));
      assert.equal(tracked.has("gen.txt"), false); // never added
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves paths relative to a subdirectory cwd", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-git-"));
    try {
      await git(dir, "init", "-q");
      await git(dir, "config", "user.name", "t");
      await git(dir, "config", "user.email", "t@t");
      await mkdir(join(dir, "pkg"));
      await writeFile(join(dir, "pkg", "lib.ts"), "l");
      await git(dir, "add", ".");
      await git(dir, "commit", "-qm", "init");

      const tracked = await detectTrackedFiles(join(dir, "pkg"));
      assert.ok(tracked);
      assert.ok(tracked.has("lib.ts")); // relative to pkg/
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("isTracked", () => {
  it("classifies paths against the set", () => {
    const set = new Set(["a.ts", "sub/b.ts"]);
    assert.equal(isTracked(set, "a.ts"), true);
    assert.equal(isTracked(set, "sub/b.ts"), true);
    assert.equal(isTracked(set, "gen.txt"), false);
  });

  it("returns undefined when git info is absent", () => {
    assert.equal(isTracked(null, "a.ts"), undefined);
  });
});

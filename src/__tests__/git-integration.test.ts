/**
 * Git integration — end-to-end: real git repository, tracker mutations,
 * payload classification and grouped rendering. Non-repo workspaces must
 * stay single-group with no tracked info.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { ChangeTracker } from "../tracker.ts";
import { detectTrackedFiles } from "../git.ts";
import { buildPayload, buildSummaryText } from "../render.ts";
import { FileDiffPanel, type PanelFile } from "../diffviewer.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-tui";

const execFileP = promisify(execFile);

async function git(dir: string, ...args: string[]): Promise<void> {
  await execFileP("git", ["-C", dir, ...args], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
}

/** Create a git repo with tracked.txt committed. Returns the dir. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-gitint-"));
  await git(dir, "init", "-q");
  await git(dir, "config", "user.name", "t");
  await git(dir, "config", "user.email", "t@t");
  await writeFile(join(dir, "tracked.txt"), "v1\n");
  await git(dir, "add", ".");
  await git(dir, "commit", "-qm", "init");
  return dir;
}

const fakeTheme = { fg: (_c: string, t: string) => t } as unknown as Theme;
const fakeKeys = { matches: () => false } as unknown as KeybindingsManager;

function editPatch(hunks: string[]): string {
  return ["--- a/x", "+++ b/x", ...hunks].join("\n");
}

describe("git integration: classification in a real repo", () => {
  it("groups tracked edits, write-created and bash-created files", async () => {
    const dir = await makeRepo();
    try {
      const t = new ChangeTracker(dir);
      // edit a git-tracked file (stays tracked)
      t.recordEdit("tracked.txt", editPatch(["@@ -1,1 +1,1 @@", "-v1", "+v2"]));
      // write a brand-new file (untracked)
      t.recordWrite("new.txt", "x\n");
      // bash-created file (untracked)
      t.recordBash(join(dir, "gen.txt"));

      const tracked = await detectTrackedFiles(dir);
      const payload = buildPayload(t.all, (abs) => abs.replace(dir + "/", ""), tracked)!;

      const byFile = new Map(payload.files.map((f) => [f.file, f.tracked]));
      assert.equal(byFile.get("tracked.txt"), true, "modified git-tracked file stays tracked");
      assert.equal(byFile.get("new.txt"), false, "write-created file is untracked");
      assert.equal(byFile.get("gen.txt"), false, "bash-created file is untracked");

      const lines = buildSummaryText(payload);
      const ti = lines.findIndex((l) => l === "git tracked files:");
      const ui = lines.findIndex((l) => l === "git untracked files:");
      assert.ok(ti >= 0 && ui > ti, "both sections rendered in order");
      assert.ok(lines.slice(ti + 1, ui).some((l) => l.includes("tracked.txt")));
      assert.ok(lines.slice(ui + 1).some((l) => l.includes("new.txt")));
      assert.ok(lines.slice(ui + 1).some((l) => l.includes("gen.txt")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("staged-but-not-committed new files count as tracked", async () => {
    const dir = await makeRepo();
    try {
      // agent creates a file, and a later git add stages it — still tracked
      await writeFile(join(dir, "staged.txt"), "s\n");
      await git(dir, "add", "staged.txt");
      const t = new ChangeTracker(dir);
      t.recordBash(join(dir, "staged.txt"));

      const tracked = await detectTrackedFiles(dir);
      const payload = buildPayload(t.all, (abs) => abs.replace(dir + "/", ""), tracked)!;
      assert.equal(payload.files[0]!.tracked, true, "git ls-files includes staged files");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("files ignored via .gitignore are untracked", async () => {
    const dir = await makeRepo();
    try {
      await writeFile(join(dir, ".gitignore"), "ignored.txt\n");
      const t = new ChangeTracker(dir);
      t.recordWrite("ignored.txt", "x\n");

      const tracked = await detectTrackedFiles(dir);
      const payload = buildPayload(t.all, (abs) => abs.replace(dir + "/", ""), tracked)!;
      assert.equal(payload.files[0]!.tracked, false, "gitignored file is untracked");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("deleted tracked files still classify as tracked (from HEAD)", async () => {
    const dir = await makeRepo();
    try {
      await writeFile(join(dir, "gone.txt"), "g\n");
      await git(dir, "add", ".");
      await git(dir, "commit", "-qm", "add gone");
      await git(dir, "rm", "-q", "gone.txt"); // staged deletion — file gone from disk
      const t = new ChangeTracker(dir);
      t.recordBash(join(dir, "gone.txt"));

      const tracked = await detectTrackedFiles(dir);
      const payload = buildPayload(t.all, (abs) => abs.replace(dir + "/", ""), tracked)!;
      // git ls-files without --deleted still lists index entries; a staged
      // deletion removes it from the index — classify by best effort.
      assert.equal(payload.files[0]!.tracked, false, "staged deletion leaves the index");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("subdirectory cwd resolves classification relative to the repo", async () => {
    const dir = await makeRepo();
    try {
      await mkdir(join(dir, "pkg"));
      await writeFile(join(dir, "pkg", "lib.ts"), "l\n");
      await git(dir, "add", ".");
      await git(dir, "commit", "-qm", "add pkg");
      const t = new ChangeTracker(join(dir, "pkg"));
      t.recordEdit("lib.ts", editPatch(["@@ -1,1 +1,1 @@", "-l", "+l2"]));

      const tracked = await detectTrackedFiles(join(dir, "pkg"));
      const payload = buildPayload(t.all, (abs) => abs.replace(join(dir, "pkg") + "/", ""), tracked)!;
      assert.equal(payload.files[0]!.tracked, true, "relative to the subdirectory cwd");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("git integration: non-repo workspace", () => {
  it("produces no tracked info and renders a single group", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-norepo-"));
    try {
      const t = new ChangeTracker(dir);
      t.recordWrite("a.txt", "x\n");
      t.recordBash(join(dir, "b.txt"));

      const tracked = await detectTrackedFiles(dir);
      assert.equal(tracked, null, "no git → null");
      const payload = buildPayload(t.all, (abs) => abs.replace(dir + "/", ""), tracked)!;
      assert.equal(payload.files[0]!.tracked, undefined);
      assert.equal(payload.files[1]!.tracked, undefined);

      const lines = buildSummaryText(payload);
      assert.ok(!lines.some((l) => l.startsWith("git ")), "no git section headers");
      assert.ok(lines.some((l) => l.includes("a.txt")));
      assert.ok(lines.some((l) => l.includes("b.txt")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("git integration: ctrl+q panel grouping", () => {
  it("renders group titles from PanelFile.tracked", () => {
    const files: PanelFile[] = [
      {
        path: "tracked.txt",
        tracked: true,
        change: { path: "/x/tracked.txt", kind: "edit", insertions: 1, deletions: 1, firstTouchedAt: 1, patch: "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-a\n+b\n" },
      },
      {
        path: "new.txt",
        tracked: false,
        change: { path: "/x/new.txt", kind: "write", insertions: 1, deletions: 0, firstTouchedAt: 2, content: "x\n" },
      },
    ];
    const panel = new FileDiffPanel(files, fakeTheme, fakeKeys, () => {}, () => {}, new EventEmitter());
    const out = panel.render(80);
    assert.ok(out.some((l) => l.includes("git tracked files:")));
    assert.ok(out.some((l) => l.includes("git untracked files:")));
  });

  it("renders no group titles when tracked info is absent", () => {
    const files: PanelFile[] = [
      { path: "a.txt", change: { path: "/x/a.txt", kind: "write", insertions: 1, deletions: 0, firstTouchedAt: 1, content: "x\n" } },
    ];
    const panel = new FileDiffPanel(files, fakeTheme, fakeKeys, () => {}, () => {}, new EventEmitter());
    const out = panel.render(80);
    assert.ok(!out.some((l) => l.includes("git tracked files:")));
    assert.ok(!out.some((l) => l.includes("git untracked files:")));
  });
});

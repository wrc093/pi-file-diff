import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ChangeTracker,
  MAX_BASH_FILES,
  MTIME_GUARD_MS,
  parsePatchStats,
  walkWorkspace,
} from "../tracker.ts";

const CWD = "/work/proj";
const SAMPLE_PATCH = [
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,5 +1,5 @@",
  " line1",
  "-old line",
  "+new line",
  " line4",
  " line5",
  "\\ No newline at end of file",
].join("\n");

function makeTracker(): ChangeTracker {
  return new ChangeTracker(CWD);
}

function editPatch(hunks: string[], header = "--- a/src/a.ts\n+++ b/src/a.ts"): string {
  return [header, ...hunks].join("\n");
}

describe("parsePatchStats", () => {
  it("counts +/- lines and ignores +++/--- headers", () => {
    const s = parsePatchStats(SAMPLE_PATCH);
    assert.equal(s.insertions, 1);
    assert.equal(s.deletions, 1);
  });

  it("ignores \\ No newline markers and counts multiple hunks", () => {
    const patch = editPatch([
      "@@ -1,1 +1,1 @@",
      "-a",
      "+b",
      "@@ -10,2 +10,3 @@",
      " c",
      "+d",
      "+e",
      "-f",
    ]);
    const s = parsePatchStats(patch);
    assert.equal(s.insertions, 3);
    assert.equal(s.deletions, 2);
  });

  it("returns zeros for empty patch", () => {
    assert.deepEqual(parsePatchStats(""), { insertions: 0, deletions: 0 });
  });
});

describe("ChangeTracker path handling", () => {
  it("normalizes relative paths against cwd", () => {
    const t = makeTracker();
    assert.equal(t.normalizePath("src/a.ts"), "/work/proj/src/a.ts");
    assert.equal(t.normalizePath("./src/a.ts"), "/work/proj/src/a.ts");
    assert.equal(t.normalizePath("../outside.ts"), "/work/outside.ts");
  });

  it("keeps absolute paths as-is", () => {
    const t = makeTracker();
    assert.equal(t.normalizePath("/tmp/out.md"), "/tmp/out.md");
  });

  it("displayPath shows relative inside cwd, absolute outside", () => {
    const t = makeTracker();
    assert.equal(t.displayPath("/work/proj/src/a.ts"), "src/a.ts");
    assert.equal(t.displayPath("/work/proj/a.ts"), "a.ts");
    assert.equal(t.displayPath("/tmp/out.md"), "/tmp/out.md");
  });
});

describe("ChangeTracker recordEdit", () => {
  it("records patch and stats for a single edit", () => {
    const t = makeTracker();
    t.recordEdit("src/a.ts", SAMPLE_PATCH);
    const all = t.all;
    assert.equal(all.length, 1);
    const c = all[0]!;
    assert.equal(c.kind, "edit");
    assert.equal(c.path, "/work/proj/src/a.ts");
    assert.equal(c.insertions, 1);
    assert.equal(c.deletions, 1);
    assert.equal(c.patch, SAMPLE_PATCH);
  });

  it("accumulates patches and stats for repeated edits to the same file", () => {
    const t = makeTracker();
    const p1 = editPatch(["@@ -1,1 +1,1 @@", "-a", "+b"]);
    const p2 = editPatch(["@@ -5,1 +5,1 @@", "-x", "+y", "+z"]);
    t.recordEdit("src/a.ts", p1);
    t.recordEdit("src/a.ts", p2);
    const all = t.all;
    assert.equal(all.length, 1);
    assert.equal(all[0]!.insertions, 3);
    assert.equal(all[0]!.deletions, 2);
    assert.match(all[0]!.patch!, /-a\n\+b/);
    assert.match(all[0]!.patch!, /-x\n\+y\n\+z/);
  });

  it("tracks separate files independently", () => {
    const t = makeTracker();
    t.recordEdit("a.ts", editPatch(["@@ -1,1 +1,1 @@", "-a", "+b"]));
    t.recordEdit("b.ts", editPatch(["@@ -1,1 +1,1 @@", "-c", "+d"]));
    assert.equal(t.size, 2);
    assert.deepEqual(
      t.all.map((c) => c.path),
      ["/work/proj/a.ts", "/work/proj/b.ts"],
    );
  });

  it("ignores edits without a patch", () => {
    const t = makeTracker();
    t.recordEdit("a.ts", undefined);
    assert.equal(t.size, 0);
  });

  it("converts a write-then-edit file to edit kind", () => {
    const t = makeTracker();
    t.recordWrite("a.ts", "line1\nline2\n");
    const patch = editPatch(["@@ -1,2 +1,2 @@", "-line1", "+line1x"]);
    t.recordEdit("a.ts", patch);
    const c = t.all[0]!;
    assert.equal(c.kind, "edit");
    assert.equal(c.content, undefined);
    assert.equal(c.insertions, 1);
    assert.equal(c.deletions, 1);
  });
});

describe("ChangeTracker recordWrite", () => {
  it("counts lines and stores content", () => {
    const t = makeTracker();
    t.recordWrite("src/new.ts", "a\nb\nc\n");
    const c = t.all[0]!;
    assert.equal(c.kind, "write");
    assert.equal(c.lineCount, 3);
    assert.equal(c.insertions, 3);
    assert.equal(c.deletions, 0);
    assert.equal(c.content, "a\nb\nc\n");
  });

  it("handles empty content", () => {
    const t = makeTracker();
    t.recordWrite("empty.ts", "");
    const c = t.all[0]!;
    assert.equal(c.lineCount, 0);
    assert.equal(c.insertions, 0);
  });

  it("replaces previous record when writing the same file twice", () => {
    const t = makeTracker();
    t.recordWrite("a.ts", "v1\n");
    t.recordWrite("a.ts", "v2\nv2b\n");
    const all = t.all;
    assert.equal(all.length, 1);
    assert.equal(all[0]!.content, "v2\nv2b\n");
    assert.equal(all[0]!.insertions, 2);
    assert.equal(all[0]!.firstTouchedAt, all[0]!.firstTouchedAt); // sanity
  });

  it("converts an edit-then-write file to write kind", () => {
    const t = makeTracker();
    t.recordEdit("a.ts", editPatch(["@@ -1,1 +1,1 @@", "-a", "+b"]));
    t.recordWrite("a.ts", "fresh\n");
    const c = t.all[0]!;
    assert.equal(c.kind, "write");
    assert.equal(c.patch, undefined);
    assert.equal(c.insertions, 1);
  });

  it("truncates oversized content but keeps lineCount from full content", () => {
    const t = makeTracker();
    const big = "x\n".repeat(30_000); // > 20k chars
    t.recordWrite("big.ts", big);
    const c = t.all[0]!;
    assert.equal(c.contentTruncated, true);
    assert.equal(c.content!.length, 20_000);
    assert.equal(c.lineCount, 30_000);
    assert.equal(c.insertions, 30_000);
  });
});

describe("ChangeTracker.all ordering", () => {
  it("is deterministic: ties on firstTouchedAt fall back to path order", () => {
    const t = makeTracker();
    // Both records land in the same millisecond, so firstTouchedAt ties
    // and the sort must fall back to path order (a.ts before b.ts).
    t.recordEdit("b.ts", editPatch(["@@ -1,1 +1,1 @@", "-a", "+b"]));
    t.recordEdit("a.ts", editPatch(["@@ -1,1 +1,1 @@", "-a", "+b"]));
    const all = t.all;
    assert.deepEqual(
      all.map((c) => c.path),
      ["/work/proj/a.ts", "/work/proj/b.ts"],
    );
  });
});

describe("walkWorkspace", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-file-diff-"));
    await mkdir(join(dir, "sub"));
    await writeFile(join(dir, "top.txt"), "top");
    await writeFile(join(dir, "sub", "deep.txt"), "deep");
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "node_modules", "ignored.txt"), "x");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("walks nested files and skips ignored dirs", async () => {
    const found: string[] = [];
    await walkWorkspace(dir, (abs) => found.push(abs));
    const names = found.map((f) => f.replace(dir + "/", "")).sort();
    assert.deepEqual(names, ["sub/deep.txt", "top.txt"]);
  });
});

describe("ChangeTracker.collectBashChanges", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-file-diff-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("detects recently modified files not tracked by edit/write", async () => {
    const t = new ChangeTracker(dir);
    const now = Date.now();
    await writeFile(join(dir, "old.txt"), "old"); // mtime = now
    await writeFile(join(dir, "generated.txt"), "gen");
    await utimes(join(dir, "old.txt"), new Date(now - 60_000), new Date(now - 60_000)); // 1 min ago
    t.recordEdit("tracked.txt", editPatch(["@@ -1,1 +1,1 @@", "-a", "+b"])); // tracked via edit

    await t.collectBashChanges(now - 5_000);

    const kinds = new Map(t.all.map((c) => [c.path, c.kind]));
    assert.equal(kinds.get(join(dir, "generated.txt")), "bash");
    assert.equal(kinds.has(join(dir, "old.txt")), false); // older than startTime
    assert.equal(kinds.get(join(dir, "tracked.txt")), "edit"); // untouched by scan
  });

  it("respects the mtime guard tolerance", async () => {
    const t = new ChangeTracker(dir);
    await writeFile(join(dir, "just-touched.txt"), "x");
    // mtime within MTIME_GUARD_MS before startTime should still be detected
    await t.collectBashChanges(Date.now() - (MTIME_GUARD_MS - 500));
    assert.equal(t.all.some((c) => c.kind === "bash"), true);
  });

  it("caps the number of bash files recorded", async () => {
    const t = new ChangeTracker(dir);
    for (let i = 0; i < MAX_BASH_FILES + 20; i++) {
      await writeFile(join(dir, `f${i}.txt`), "x");
    }
    await t.collectBashChanges(Date.now() - 5_000);
    const bashCount = t.all.filter((c) => c.kind === "bash").length;
    assert.equal(bashCount, MAX_BASH_FILES);
  });

  it("does nothing when startTime is 0", async () => {
    const t = new ChangeTracker(dir);
    await writeFile(join(dir, "f.txt"), "x");
    await t.collectBashChanges(0);
    assert.equal(t.size, 0);
  });
});

describe("ChangeTracker bash-modifies-tracked-file (bug repro)", () => {
  it("marks a tracked file when bash modifies it again", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-bug-"));
    try {
      const t = new ChangeTracker(dir);
      // 1. agent writes the file (tracked as write)
      await writeFile(join(dir, "a.txt"), "alpha\n");
      t.recordWrite("a.txt", "alpha\n");
      // 2. agent appends via bash echo
      await writeFile(join(dir, "a.txt"), "alpha\nbeta\n");
      const now = Date.now();
      await t.collectBashChanges(now - 5_000);
      const c = t.all[0]!;
      assert.equal(c.kind, "write"); // keep original diff kind
      assert.equal(c.shellTouched, true); // but flag the extra shell change
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps pure-bash files as bash entries", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-bug-"));
    try {
      const t = new ChangeTracker(dir);
      await writeFile(join(dir, "gen.txt"), "data\n");
      await t.collectBashChanges(Date.now() - 5_000);
      assert.equal(t.all[0]!.kind, "bash");
      assert.equal(t.all[0]!.shellTouched, undefined);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ChangeTracker.collectBashChanges with snapshot", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-file-diff-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("builds a real diff for a shell-append to an existing file", async () => {
    const t = new ChangeTracker(dir);
    const snap = new Map([[join(dir, "f.txt"), "alpha\n"]]);
    await writeFile(join(dir, "f.txt"), "alpha\nbeta\n");

    await t.collectBashChanges(Date.now() - 5_000, snap);

    const c = t.all[0]!;
    assert.equal(c.kind, "bash");
    assert.ok(c.bashDiff, "should have a diff");
    assert.match(c.bashDiff!, /\+beta/);
    assert.equal(c.insertions, 1);
    assert.equal(c.deletions, 0);
  });

  it("treats files absent from the snapshot as all-added", async () => {
    const t = new ChangeTracker(dir);
    await writeFile(join(dir, "gen.txt"), "line1\nline2\n");

    await t.collectBashChanges(Date.now() - 5_000, new Map());

    const c = t.all[0]!;
    assert.equal(c.kind, "bash");
    assert.ok(c.bashDiff);
    assert.match(c.bashDiff!, /\+line1/);
    assert.equal(c.insertions, 2);
  });

  it("records deletions when a snapshot file vanished", async () => {
    const t = new ChangeTracker(dir);
    const snap = new Map([[join(dir, "gone.txt"), "old\ncontent\n"]]);

    await t.collectBashChanges(Date.now() - 5_000, snap);

    const c = t.all[0]!;
    assert.equal(c.kind, "bash");
    assert.ok(c.bashDiff);
    assert.match(c.bashDiff!, /-old/);
    assert.equal(c.insertions, 0);
    assert.equal(c.deletions, 2);
  });

  it("recomputes stats for shellTouched tracked files from the snapshot", async () => {
    const t = new ChangeTracker(dir);
    const snap = new Map([[join(dir, "a.txt"), "alpha\n"]]);
    // agent wrote the file, then bash appended
    t.recordWrite("a.txt", "alpha\n");
    await writeFile(join(dir, "a.txt"), "alpha\nbeta\n");

    await t.collectBashChanges(Date.now() - 5_000, snap);

    const c = t.all[0]!;
    assert.equal(c.kind, "write"); // original kind preserved
    assert.equal(c.shellTouched, true);
    assert.ok(c.bashDiff);
    assert.match(c.bashDiff!, /\+beta/);
    // snapshot-vs-current stats: only beta is new (alpha already existed)
    assert.equal(c.insertions, 1);
    assert.equal(c.deletions, 0);
  });

  it("leaves no diff when snapshot is unavailable", async () => {
    const t = new ChangeTracker(dir);
    await writeFile(join(dir, "f.txt"), "x\n");

    await t.collectBashChanges(Date.now() - 5_000, undefined);

    const c = t.all[0]!;
    assert.equal(c.kind, "bash");
    assert.equal(c.bashDiff, undefined, "no baseline at all → cannot diff");
    assert.equal(c.insertions, 0);
  });
});

describe("ChangeTracker.resolveFileStatuses", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-file-diff-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("classifies added / modified / deleted files from snapshot + disk", async () => {
    const t = new ChangeTracker(dir);
    // existed at snapshot time:
    await writeFile(join(dir, "mod.txt"), "v1\n");
    await writeFile(join(dir, "del.txt"), "old\n");
    // new file created after snapshot:
    await writeFile(join(dir, "new.txt"), "x\n");
    // deleted after snapshot:
    await rm(join(dir, "del.txt"));

    const seen = new Set([join(dir, "mod.txt"), join(dir, "del.txt")]);
    t.recordEdit("mod.txt", editPatch(["@@ -1,1 +1,1 @@", "-v1", "+v2"]));
    t.recordWrite("new.txt", "x\n");
    t.recordBash(join(dir, "del.txt"));

    await t.resolveFileStatuses(seen);

    const byPath = new Map(t.all.map((c) => [c.path, c.fileStatus]));
    assert.equal(byPath.get(join(dir, "mod.txt")), "M");
    assert.equal(byPath.get(join(dir, "new.txt")), "A");
    assert.equal(byPath.get(join(dir, "del.txt")), "D");
  });

  it("skips resolution without a snapshot", async () => {
    const t = new ChangeTracker(dir);
    t.recordWrite("new.txt", "x\n");
    await t.resolveFileStatuses(null);
    assert.equal(t.all[0]!.fileStatus, undefined);
  });

  it("is idempotent", async () => {
    const t = new ChangeTracker(dir);
    await writeFile(join(dir, "a.txt"), "x\n");
    t.recordWrite("a.txt", "x\n");
    const seen = new Set([join(dir, "a.txt")]);
    await t.resolveFileStatuses(seen);
    await t.resolveFileStatuses(seen);
    assert.equal(t.all[0]!.fileStatus, "M");
  });
});

describe("ChangeTracker.all ordering (edit/write first)", () => {
  it("orders bash changes after edit/write regardless of touch time", () => {
    const t = makeTracker();
    // bash first (would sort first by time), then edit, then write
    t.recordBash("/work/proj/s1.txt");
    t.recordEdit("a.ts", editPatch(["@@ -1,1 +1,1 @@", "-a", "+b"]));
    t.recordWrite("w.ts", "x\n");
    t.recordBash("/work/proj/s2.txt");
    const kinds = t.all.map((c) => c.kind);
    assert.deepEqual(kinds, ["edit", "write", "bash", "bash"]);
    // within bash group: time order preserved
    assert.deepEqual(t.all.slice(2).map((c) => c.path), ["/work/proj/s1.txt", "/work/proj/s2.txt"]);
  });
});

describe("ChangeTracker.resolveFileStatuses per-run semantics", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-file-diff-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("appending to a file created in an earlier run is M, not A", async () => {
    const t = new ChangeTracker(dir);
    // run 1 created c.txt — already tracked, file exists on disk now
    await writeFile(join(dir, "c.txt"), "first\n");
    t.recordBash(join(dir, "c.txt"), "--- x\n+++ x\n@@ -0,0 +1,1 @@\n+first\n");
    // run 2 baseline: c.txt existed when run 2 started
    const runSeen = new Set([join(dir, "c.txt")]);

    await t.resolveFileStatuses(runSeen);

    const c = t.all[0]!;
    assert.equal(c.fileStatus, "M", "file existed at run start → modification");
  });

  it("file created within the current run stays A", async () => {
    const t = new ChangeTracker(dir);
    await writeFile(join(dir, "gen.txt"), "x\n");
    t.recordBash(join(dir, "gen.txt"), "--- x\n+++ x\n@@ -0,0 +1,1 @@\n+x\n");
    // run baseline did NOT contain gen.txt
    await t.resolveFileStatuses(new Set());
    assert.equal(t.all[0]!.fileStatus, "A");
  });
});

describe("ChangeTracker mutation counter", () => {
  it("counts edit/write/bash mutations and shell flags", async () => {
    const t = makeTracker();
    assert.equal(t.mutations, 0);
    t.recordEdit("a.ts", editPatch(["@@ -1,1 +1,1 @@", "-a", "+b"]));
    assert.equal(t.mutations, 1);
    t.recordEdit("a.ts", undefined); // no patch — not counted
    assert.equal(t.mutations, 1);
    t.recordWrite("b.ts", "x\n");
    assert.equal(t.mutations, 2);
    t.recordBash("/work/proj/s.ts");
    assert.equal(t.mutations, 3);
    t.recordBash("/work/proj/s.ts"); // duplicate — not counted
    assert.equal(t.mutations, 3);
  });

  it("counts shellTouched flags on already-tracked files", async () => {
    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "pi-file-diff-"));
    try {
      const t = new ChangeTracker(dir);
      t.recordWrite("a.txt", "alpha\n");
      const before = t.mutations;
      await writeFile(join(dir, "a.txt"), "alpha\nbeta\n");
      await t.collectBashChanges(Date.now() - 5_000, new Map([[join(dir, "a.txt"), "alpha\n"]]));
      assert.equal(t.mutations, before + 1, "shell flag on tracked file counts as a mutation");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("ChangeTracker bash-tracked file modified again (bug repro)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-file-diff-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refreshes the diff and counts a mutation when a bash-tracked file is modified again", async () => {
    const t = new ChangeTracker(dir);
    // turn 1: file created via bash (tracked as kind=bash, all-added diff)
    await writeFile(join(dir, "f.txt"), "v1\n");
    const snap = new Map(); // conversation snapshot: f.txt did not exist
    await t.collectBashChanges(Date.now() - 5_000, snap);
    const first = t.all[0]!;
    assert.equal(first.kind, "bash");
    const firstDiff = first.bashDiff; // snapshot the string — the object mutates in place
    const mutationsAfterTurn1 = t.mutations;

    // turn 3: bash appends to the same file
    await writeFile(join(dir, "f.txt"), "v1\nappended\n");
    await t.collectBashChanges(Date.now() - 5_000, snap);
    const second = t.all[0]!;
    assert.ok(second.bashDiff !== firstDiff, "diff must be refreshed");
    assert.match(second.bashDiff!, /appended/);
    assert.equal(t.mutations, mutationsAfterTurn1 + 1, "mutation must be counted");
  });

  it("does not double-count when a re-scan produces an identical patch", async () => {
    const t = new ChangeTracker(dir);
    await writeFile(join(dir, "f.txt"), "v1\n");
    const snap = new Map();
    await t.collectBashChanges(Date.now() - 5_000, snap);
    const before = t.mutations;
    // same content, same mtime window → identical patch
    await t.collectBashChanges(Date.now() - 5_000, snap);
    assert.equal(t.mutations, before, "identical re-scan must not count");
  });
});

describe("ChangeTracker content-unchanged mtime touch (bug repro)", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-file-diff-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("touch with identical content is not recorded and does not count", async () => {
    const t = new ChangeTracker(dir);
    await writeFile(join(dir, "state.json"), '{"a":1}\n');
    // first observation records the file (mtime window, content known)
    await t.collectBashChanges(Date.now() - 5_000, new Map());
    assert.equal(t.size, 1);
    const afterFirst = t.mutations;

    // re-rewrite the SAME content → mtime changes, content does not
    await writeFile(join(dir, "state.json"), '{"a":1}\n');
    await t.collectBashChanges(Date.now() - 5_000, new Map());
    assert.equal(t.size, 1, "no new entry");
    assert.equal(t.mutations, afterFirst, "identical rewrite must not count");
  });

  it("a genuine content change is still detected after an identical rewrite", async () => {
    const t = new ChangeTracker(dir);
    await writeFile(join(dir, "state.json"), '{"a":1}\n');
    await t.collectBashChanges(Date.now() - 5_000, new Map());
    const afterFirst = t.mutations;

    // identical rewrite (ignored), then a real change
    await writeFile(join(dir, "state.json"), '{"a":1}\n');
    await writeFile(join(dir, "state.json"), '{"a":2}\n');
    await t.collectBashChanges(Date.now() - 5_000, new Map());
    assert.equal(t.mutations, afterFirst + 1, "real change counts");
    assert.match(t.all[0]!.bashDiff ?? "", /"a":2/, "new content in the diff");
  });

  it("binary/unreadable files still get a path-only entry", async () => {
    const t = new ChangeTracker(dir);
    await writeFile(join(dir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02]));
    await t.collectBashChanges(Date.now() - 5_000, new Map());
    const c = t.all[0]!;
    assert.equal(c.kind, "bash");
    assert.equal(c.bashDiff, undefined, "no diff for binary");
    assert.equal(c.insertions, 0);
  });
});

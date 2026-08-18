import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";
import { completePath, expandHome, resolveUserPath } from "../path-complete.ts";
import { ChangeTracker } from "../tracker.ts";
import { buildPayload, buildSummaryText } from "../render.ts";

const CWD = "/work/proj";

describe("expandHome / resolveUserPath", () => {
  it("expands ~ and resolves relative paths against cwd", () => {
    assert.equal(expandHome("~"), homedir());
    assert.equal(expandHome("~/x"), join(homedir(), "x"));
    assert.equal(expandHome("/abs"), "/abs");
    assert.equal(resolveUserPath("a/b.txt", CWD), "/work/proj/a/b.txt");
    assert.equal(resolveUserPath("/abs/x", CWD), "/abs/x");
    assert.equal(resolveUserPath("~/y", CWD), join(homedir(), "y"));
  });
});

describe("completePath", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-file-diff-complete-"));
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "node_modules"));
    await writeFile(join(dir, "src", "a.ts"), "x");
    await writeFile(join(dir, "src", "b.ts"), "x");
    await writeFile(join(dir, "notes.md"), "x");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("completes names from cwd, dirs first with trailing slash", () => {
    const out = completePath("", dir);
    assert.ok(out.some((c) => c.value === join(dir, "src") + "/"), "dir gets trailing slash");
    assert.ok(out.some((c) => c.value === join(dir, "notes.md")), "file without slash");
    const srcIdx = out.findIndex((c) => c.value.endsWith("src/"));
    const fileIdx = out.findIndex((c) => c.value.endsWith("notes.md"));
    assert.ok(srcIdx >= 0 && fileIdx > srcIdx, "dirs sorted before files");
  });

  it("filters by prefix and descends into directories", () => {
    const out = completePath(join(dir, "sr"), dir);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.value, join(dir, "src") + "/");

    const deeper = completePath(join(dir, "src/"), dir);
    assert.ok(deeper.some((c) => c.value.endsWith("/src/a.ts")));
    assert.ok(deeper.some((c) => c.value.endsWith("/src/b.ts")));
  });

  it("keeps relative prefixes relative", () => {
    const out = completePath("sr", dir);
    assert.equal(out[0]!.value, "src/");
  });

  it("returns empty for a missing directory", () => {
    assert.deepEqual(completePath(join(dir, "nope/"), dir), []);
  });
});

describe("ChangeTracker exclusions", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-file-diff-excl-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const P = (f: string) => join(dir, f);

  it("skips recording edit/write/bash for excluded paths", async () => {
    await mkdir(P("noisy"));
    const t = new ChangeTracker(dir, undefined, new Set([P("noisy")]));
    t.recordWrite("noisy/a.txt", "x\n");
    t.recordEdit("noisy/a.txt", "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-x\n+y\n");
    t.recordBash(P("noisy/b.txt"));
    t.recordWrite("keep.txt", "y\n");
    assert.equal(t.size, 1);
    assert.equal(t.all[0]!.path, P("keep.txt"));
    assert.equal(t.mutations, 1, "excluded records must not count");
  });

  it("excludes exact files and directory prefixes", async () => {
    await writeFile(P("a.txt"), "x\n");
    await writeFile(P("sub.txt"), "x\n");
    const t = new ChangeTracker(dir, undefined, new Set([P("a.txt")]));
    t.recordWrite("a.txt", "x\n"); // exact file
    t.recordWrite("sub.txt", "x\n"); // not excluded
    assert.equal(t.size, 1);
    assert.equal(t.all[0]!.path, P("sub.txt"));
  });

  it("bash scan skips excluded files (and their changes)", async () => {
    await mkdir(P("logs"));
    await writeFile(P("logs/x.log"), "old\n");
    await writeFile(P("gen.txt"), "old\n");
    const t = new ChangeTracker(dir, undefined, new Set([P("logs")]));
    await writeFile(P("logs/x.log"), "new\n");
    await writeFile(P("gen.txt"), "new\n");
    await t.collectBashChanges(Date.now() - 5_000, new Map());
    assert.equal(t.size, 1);
    assert.equal(t.all[0]!.path, P("gen.txt"), "excluded dir changes are invisible");
  });

  it("buildPayload filters already-recorded excluded changes", async () => {
    const t = new ChangeTracker(dir);
    t.recordWrite("a.txt", "x\n");
    t.recordWrite("b.txt", "y\n");
    const exclude = new Set([P("a.txt")]);
    const payload = buildPayload(t.all, (abs) => abs.replace(dir + "/", ""), null, exclude)!;
    assert.deepEqual(payload.files.map((f) => f.file), ["b.txt"]);
    assert.equal(payload.totalFiles, 1);
    assert.equal(payload.totalInsertions, 1);
  });

  it("renders the exclude hint when the summary overflows", () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      file: `f${i}.ts`,
      status: "M" as const,
      kind: "edit" as const,
      insertions: 1,
      deletions: 0,
    }));
    const payload = { files: many, totalFiles: 15, totalInsertions: 15, totalDeletions: 0 };
    const lines = buildSummaryText(payload);
    assert.ok(lines.some((l) => l.includes("file-diff-exclude")), "hint mentions the exclude command");
  });
});

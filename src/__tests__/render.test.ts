import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildChangeTree,
  buildPayload,
  buildSummaryText,
  collapseEntries,
  isSummaryPayload,
  MAX_FILES,
  splitContentLines,
  splitPatchLines,
  type ColorFn,
  type SummaryPayload,
} from "../render.ts";
import { zhMessages } from "../i18n.ts";
import type { TrackedChange } from "../tracker.ts";

function change(partial: Partial<TrackedChange>): TrackedChange {
  return {
    path: "/work/proj/a.ts",
    kind: "edit",
    insertions: 0,
    deletions: 0,
    firstTouchedAt: 1,
    ...partial,
  };
}

const idPath = (abs: string) => abs.replace("/work/proj/", "");

describe("splitPatchLines", () => {
  it("drops ---/+++ headers and trailing blanks", () => {
    const { lines, remaining } = splitPatchLines(
      "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n",
      12,
    );
    assert.deepEqual(lines, ["@@ -1,1 +1,1 @@", "-a", "+b"]);
    assert.equal(remaining, 0);
  });

  it("truncates to maxLines and reports remaining", () => {
    const lines = Array.from({ length: 20 }, (_, i) => (i % 2 ? `+l${i}` : `-l${i}`));
    const { lines: shown, remaining } = splitPatchLines(`--- a/x\n+++ b/x\n${lines.join("\n")}`, 5);
    assert.equal(shown.length, 5);
    assert.equal(remaining, 15);
  });
});

describe("splitContentLines", () => {
  it("drops trailing blanks and truncates", () => {
    const { lines, remaining } = splitContentLines("a\nb\nc\n\n", 2);
    assert.deepEqual(lines, ["a", "b"]);
    assert.equal(remaining, 1);
  });
});

describe("buildPayload", () => {
  it("returns null when nothing changed", () => {
    assert.equal(buildPayload([], idPath), null);
  });

  it("maps kinds to statuses and accumulates totals", () => {
    const payload = buildPayload(
      [
        change({ path: "/work/proj/e.ts", kind: "edit", insertions: 3, deletions: 2 }),
        change({ path: "/work/proj/n.ts", kind: "write", insertions: 5, deletions: 0 }),
        change({ path: "/work/proj/s.ts", kind: "bash", insertions: 0, deletions: 0 }),
      ],
      idPath,
    )!;
    assert.equal(payload.totalFiles, 3);
    assert.equal(payload.totalInsertions, 8);
    assert.equal(payload.totalDeletions, 2);
    assert.deepEqual(
      payload.entries.map((e) => [e.path, e.status, e.source]),
      [
        ["e.ts", "M", undefined],
        ["n.ts", "A", undefined],
        ["s.ts", "M", "shell"],
      ],
    );
  });

  it("does not embed diff bodies in the payload (kept for the panel)", () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n";
    const payload = buildPayload(
      [change({ kind: "edit", patch, insertions: 1, deletions: 1 })],
      idPath,
    )!;
    assert.equal("change" in payload.entries[0]!, false);
    assert.equal("children" in payload.entries[0]!, false);
    assert.equal(payload.entries[0]!.insertions, 1);
  });
});

describe("buildPayload directory aggregation", () => {
  const dirChanges = (n: number, extra: Partial<TrackedChange> = {}) =>
    Array.from({ length: n }, (_, i) =>
      change({
        path: `/work/proj/ppt-master/f${i}.md`,
        kind: "write",
        insertions: 2,
        deletions: 0,
        firstTouchedAt: i + 1,
        ...extra,
      }),
    );

  it("collapses a subtree with >= threshold files into one directory entry", () => {
    const payload = buildPayload(dirChanges(6), idPath)!;
    assert.equal(payload.totalFiles, 6);
    assert.equal(payload.entries.length, 1);
    const entry = payload.entries[0]!;
    assert.deepEqual(
      [entry.kind, entry.path, entry.status, entry.fileCount, entry.insertions, entry.deletions],
      ["dir", "ppt-master", "A", 6, 12, 0],
    );
  });

  it("keeps subtrees below the threshold per file", () => {
    const payload = buildPayload(dirChanges(4), idPath)!;
    assert.equal(payload.entries.length, 4);
    assert.ok(payload.entries.every((e) => e.kind === "file"));
  });

  it("honors a custom threshold", () => {
    const payload = buildPayload(dirChanges(2), idPath, null, undefined, 2)!;
    assert.equal(payload.entries.length, 1);
    assert.equal(payload.entries[0]!.kind, "dir");
    const flat = buildPayload(dirChanges(3), idPath, null, undefined, 4)!;
    assert.ok(flat.entries.every((e) => e.kind === "file"));
  });

  it("merges directory status: all added → A, all deleted → D, otherwise M", () => {
    const added = buildPayload(dirChanges(5), idPath)!;
    assert.equal(added.entries[0]!.status, "A");

    const deleted = buildPayload(
      dirChanges(5, { kind: "bash", fileStatus: "D", insertions: 0, deletions: 3 }),
      idPath,
    )!;
    assert.equal(deleted.entries[0]!.status, "D");

    // mix of new files and content modifications → M (scheme A)
    const mixed = buildPayload(
      [
        ...dirChanges(3),
        change({ path: "/work/proj/ppt-master/keep.md", kind: "edit", insertions: 1, deletions: 1, fileStatus: "M" }),
        change({ path: "/work/proj/ppt-master/keep2.md", kind: "bash", insertions: 0, deletions: 2, fileStatus: "M" }),
      ],
      idPath,
    )!;
    assert.equal(mixed.entries[0]!.status, "M");
    assert.equal(mixed.entries[0]!.fileCount, 5);

    // content-only modifications (no new files) → M as well
    const modified = buildPayload(
      [
        change({ path: "/work/proj/ppt-master/a.md", kind: "edit", insertions: 1, deletions: 1, fileStatus: "M" }),
        change({ path: "/work/proj/ppt-master/b.md", kind: "bash", insertions: 2, deletions: 0, fileStatus: "M" }),
      ],
      idPath,
      null,
      undefined,
      2,
    )!;
    assert.equal(modified.entries[0]!.status, "M");
  });

  it("never aggregates the cwd itself or files outside it", () => {
    const payload = buildPayload(
      [
        change({ path: "/work/proj/a.ts", kind: "write", insertions: 1, deletions: 0 }),
        change({ path: "/work/proj/ppt-master/x.md", kind: "write", insertions: 1, deletions: 0 }),
        change({ path: "/work/proj/ppt-master/y.md", kind: "write", insertions: 1, deletions: 0 }),
        change({ path: "/work/proj/ppt-master/z.md", kind: "write", insertions: 1, deletions: 0 }),
        change({ path: "/work/proj/ppt-master/w.md", kind: "write", insertions: 1, deletions: 0 }),
        change({ path: "/work/proj/ppt-master/v.md", kind: "write", insertions: 1, deletions: 0 }),
        change({ path: "/somewhere/else/tmp.out", kind: "bash", insertions: 1, deletions: 0 }),
      ],
      idPath,
    )!;
    const paths = payload.entries.map((e) => e.path);
    // a.ts stays a root file; ppt-master collapses; outside-cwd file stays a file
    assert.deepEqual(paths.sort(), ["/somewhere/else/tmp.out", "a.ts", "ppt-master"]);
    assert.equal(payload.entries.find((e) => e.path === "ppt-master")!.kind, "dir");
  });

  it("builds the tree with full nested directory paths", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      path: `ppt-master/.github/workflows/ci${i}.yml`,
      status: "A" as const,
      change: change({
        path: `/work/proj/ppt-master/.github/workflows/ci${i}.yml`,
        kind: "write",
        insertions: 1,
        deletions: 0,
      }),
    }));
    const tree = buildChangeTree(items);
    assert.equal(tree.length, 1);
    // collapse at the root keeps the topmost qualifying dir; each level down
    // keeps the next qualifying dir with its full path
    const top = collapseEntries(tree, 5)[0]!;
    assert.equal(top.kind, "dir");
    assert.equal(top.path, "ppt-master");
    assert.equal(top.fileCount, 5);
    const github = collapseEntries(top.children ?? [], 5)[0]!;
    assert.equal(github.path, "ppt-master/.github");
    const workflows = collapseEntries(github.children ?? [], 5)[0]!;
    assert.equal(workflows.path, "ppt-master/.github/workflows");
  });
});

describe("buildSummaryText", () => {
  const payload: SummaryPayload = {
    entries: [
      { kind: "file", path: "src/a.ts", status: "M", insertions: 2, deletions: 1, fileCount: 1 },
      { kind: "file", path: "n.ts", status: "A", insertions: 2, deletions: 0, fileCount: 1 },
      { kind: "file", path: "s.ts", status: "M", insertions: 0, deletions: 0, fileCount: 1, source: "shell" },
    ],
    totalFiles: 3,
    totalInsertions: 4,
    totalDeletions: 1,
  };

  it("renders header with counts", () => {
    const lines = buildSummaryText(payload);
    assert.equal(lines[0], "3 files changed  +4  -1");
  });

  it("renders file lines with icons and shell marker", () => {
    const lines = buildSummaryText(payload);
    assert.ok(lines.some((l) => l.startsWith("M src/a.ts  +2 -1")));
    assert.ok(lines.some((l) => l.startsWith("+ n.ts  +2")));
    assert.ok(lines.some((l) => l.endsWith(" (shell)")));
  });

  it("renders only the file list — no diff bodies", () => {
    const lines = buildSummaryText(payload);
    assert.equal(lines.filter((l) => l.startsWith("  ")).length, 0);
    assert.ok(!lines.some((l) => l.includes("@@")));
  });

  it("ends with the ctrl+q hint", () => {
    const lines = buildSummaryText(payload);
    assert.ok(lines.some((l) => l.includes("[ctrl+q]")));
  });

  it("applies colors through the injected fg function", () => {
    const calls: Array<[string, string]> = [];
    const fg: ColorFn = (color, text) => {
      calls.push([color, text]);
      return text;
    };
    buildSummaryText(payload, fg);
    assert.ok(calls.some(([c, t]) => c === "success" && t.startsWith("+")));
    assert.ok(calls.some(([c, t]) => c === "error" && t.startsWith("-")));
    assert.ok(calls.some(([c]) => c === "muted"));
    assert.ok(calls.some(([c]) => c === "dim"));
  });

  it("highlights the ctrl+q key in accent while the rest stays dim", () => {
    const calls: Array<[string, string]> = [];
    const fg: ColorFn = (color, text) => {
      calls.push([color, text]);
      return text;
    };
    buildSummaryText(payload, fg);
    const key = calls.find(([c, t]) => c === "accent" && t === "[ctrl+q]");
    assert.ok(key, "[ctrl+q] is rendered in accent");
    const rest = calls.find(([c, t]) => c === "dim" && t.includes("/file-diff"));
    assert.ok(rest, "the rest of the hint stays dim");
  });

  it("shows overflow summary for large changesets", () => {
    const many: SummaryPayload = {
      entries: Array.from({ length: MAX_FILES }, (_, i) => ({
        kind: "file" as const,
        path: `f${i}.ts`,
        status: "M" as const,
        insertions: 1,
        deletions: 0,
        fileCount: 1,
      })),
      totalFiles: MAX_FILES + 7,
      totalInsertions: 1,
      totalDeletions: 0,
    };
    const lines = buildSummaryText(many);
    assert.ok(lines.some((l) => l === `... and 7 more`));
  });

  it("counts overflow in files, not entries, after aggregation", () => {
    // 12 directory entries × 5 files = 60 files; 10 entries shown = 50 files
    const many: SummaryPayload = {
      entries: Array.from({ length: 12 }, (_, i) => ({
        kind: "dir" as const,
        path: `d${i}`,
        status: "M" as const,
        insertions: 5,
        deletions: 0,
        fileCount: 5,
      })),
      totalFiles: 60,
      totalInsertions: 60,
      totalDeletions: 0,
    };
    const lines = buildSummaryText(many);
    assert.ok(lines.some((l) => l === "... and 10 more"), "remaining files, not entries");
    assert.ok(lines.some((l) => l.includes("file-diff-exclude")), "file-count >10 keeps the hint");
  });

  it("handles empty diff-less entries gracefully", () => {
    const empty: SummaryPayload = {
      entries: [{ kind: "file", path: "x.ts", status: "M", insertions: 0, deletions: 0, fileCount: 1, source: "shell" }],
      totalFiles: 1,
      totalInsertions: 0,
      totalDeletions: 0,
    };
    const lines = buildSummaryText(empty);
    assert.equal(lines[0], "1 file changed");
    assert.equal(lines[1], "M x.ts (shell)");
  });
});

describe("buildSummaryText directory entries", () => {
  const dirPayload = (status: "A" | "D" | "M"): SummaryPayload => ({
    entries: [
      {
        kind: "dir",
        path: "ppt-master",
        status,
        insertions: status === "D" ? 0 : 12,
        deletions: status === "D" ? 88 : 0,
        fileCount: 6,
        counts:
          status === "A"
            ? { A: 6, D: 0, M: 0 }
            : status === "D"
              ? { A: 0, D: 6, M: 0 }
              : { A: 0, D: 0, M: 6 },
      },
    ],
    totalFiles: 6,
    totalInsertions: status === "D" ? 0 : 12,
    totalDeletions: status === "D" ? 88 : 0,
  });

  it("renders an added directory with aggregated counts", () => {
    const lines = buildSummaryText(dirPayload("A"));
    const line = lines.find((l) => l.includes("ppt-master/"))!;
    assert.ok(line.startsWith("+ ppt-master/  +12"));
    assert.ok(line.includes("(6 files added)"));
  });

  it("renders a deleted directory struck through", () => {
    const lines = buildSummaryText(dirPayload("D"));
    const line = lines.find((l) => l.includes("ppt-master/"))!;
    assert.ok(line.startsWith("- "), "minus icon for deleted dirs");
    assert.ok(line.includes("\x1b[9mppt-master/\x1b[29m"), "dir path should be struck through");
    assert.ok(line.includes("-88"));
    assert.ok(line.includes("(6 files deleted)"));
  });

  it("renders a modified directory with M icon and file count", () => {
    const lines = buildSummaryText(dirPayload("M"));
    const line = lines.find((l) => l.includes("ppt-master/"))!;
    assert.ok(line.startsWith("M ppt-master/  +12"));
    assert.ok(line.includes("(6 files modified)"));
  });

  it("shows the shell marker on a directory only when all children share it", () => {
    const payload: SummaryPayload = {
      entries: [
        {
          kind: "dir",
          path: "gen",
          status: "M",
          insertions: 1,
          deletions: 0,
          fileCount: 5,
          source: "shell",
        },
        {
          kind: "dir",
          path: "mix",
          status: "M",
          insertions: 1,
          deletions: 0,
          fileCount: 5,
          source: "shell-modified",
        },
      ],
      totalFiles: 10,
      totalInsertions: 2,
      totalDeletions: 0,
    };
    const lines = buildSummaryText(payload);
    const gen = lines.find((l) => l.includes("gen/"))!;
    assert.ok(gen.includes("(shell)"), "uniform shell dir keeps the marker");
    const mix = lines.find((l) => l.includes("mix/"))!;
    assert.ok(mix.includes("(shell-modified)"));
  });
});

describe("isSummaryPayload", () => {
  it("accepts valid payloads and rejects garbage", () => {
    assert.equal(isSummaryPayload({ entries: [], totalFiles: 0 }), true);
    assert.equal(isSummaryPayload(null), false);
    assert.equal(isSummaryPayload("nope"), false);
    assert.equal(isSummaryPayload({ entries: "x" }), false);
    assert.equal(isSummaryPayload({}), false);
  });
});

describe("buildSummaryText shellTouched", () => {
  it("marks files that were shell-modified after tracking", () => {
    const payload: SummaryPayload = {
      entries: [
        { kind: "file", path: "a.txt", status: "M", insertions: 1, deletions: 1, fileCount: 1, source: "shell-modified" },
        { kind: "file", path: "b.txt", status: "A", insertions: 2, deletions: 0, fileCount: 1 },
      ],
      totalFiles: 2,
      totalInsertions: 3,
      totalDeletions: 1,
    };
    const lines = buildSummaryText(payload);
    assert.ok(lines.some((l) => l.includes("a.txt") && l.includes("(shell-modified)")));
    assert.ok(!lines.some((l) => l.includes("b.txt") && l.includes("shell")));
  });
});

describe("buildSummaryText git grouping", () => {
  it("groups entries into tracked and untracked sections", () => {
    const payload: SummaryPayload = {
      entries: [
        { kind: "file", path: "src/a.ts", status: "M", insertions: 1, deletions: 1, fileCount: 1, tracked: true },
        { kind: "file", path: "gen.txt", status: "M", insertions: 0, deletions: 0, fileCount: 1, source: "shell", tracked: false },
        { kind: "file", path: "new.ts", status: "A", insertions: 2, deletions: 0, fileCount: 1, tracked: false },
      ],
      totalFiles: 3,
      totalInsertions: 3,
      totalDeletions: 1,
    };
    const lines = buildSummaryText(payload);
    const ti = lines.findIndex((l) => l === "git tracked files:");
    const ui = lines.findIndex((l) => l === "git untracked files:");
    assert.ok(ti >= 0 && ui > ti, "tracked section must come first");
    assert.ok(lines.slice(ti + 1, ui).some((l) => l.startsWith("M src/a.ts")));
    assert.ok(lines.slice(ui + 1).some((l) => l.startsWith("M gen.txt")));
    assert.ok(lines.slice(ui + 1).some((l) => l.startsWith("+ new.ts")));
  });

  it("places mixed-tracked directory entries in the untracked section", () => {
    const payload: SummaryPayload = {
      entries: [
        { kind: "dir", path: "pkg", status: "M", insertions: 1, deletions: 1, fileCount: 5 },
        { kind: "file", path: "a.ts", status: "M", insertions: 1, deletions: 0, fileCount: 1, tracked: true },
      ],
      totalFiles: 6,
      totalInsertions: 2,
      totalDeletions: 1,
    };
    const lines = buildSummaryText(payload);
    assert.ok(lines.some((l) => l === "git tracked files:"));
    assert.ok(lines.some((l) => l === "git untracked files:"));
    assert.ok(lines.slice(lines.findIndex((l) => l === "git untracked files:")).some((l) => l.includes("pkg/")));
  });

  it("skips empty sections", () => {
    const payload: SummaryPayload = {
      entries: [{ kind: "file", path: "a.ts", status: "M", insertions: 1, deletions: 0, fileCount: 1, tracked: true }],
      totalFiles: 1,
      totalInsertions: 1,
      totalDeletions: 0,
    };
    const lines = buildSummaryText(payload);
    assert.ok(lines.some((l) => l === "git tracked files:"));
    assert.ok(!lines.some((l) => l === "git untracked files:"));
  });

  it("renders single group when git info is absent", () => {
    const payload: SummaryPayload = {
      entries: [{ kind: "file", path: "a.ts", status: "M", insertions: 1, deletions: 0, fileCount: 1 }],
      totalFiles: 1,
      totalInsertions: 1,
      totalDeletions: 0,
    };
    const lines = buildSummaryText(payload);
    assert.ok(!lines.some((l) => l.startsWith("git ")));
  });
});

describe("buildSummaryText no-diff marker", () => {
  it("labels shell changes without a computable diff", () => {
    const payload: SummaryPayload = {
      entries: [
        { kind: "file", path: "logs_2.sqlite-wal", status: "M", insertions: 0, deletions: 0, fileCount: 1, source: "shell", noDiff: true },
        { kind: "file", path: "readme.txt", status: "M", insertions: 3, deletions: 1, fileCount: 1, source: "shell" },
      ],
      totalFiles: 2,
      totalInsertions: 3,
      totalDeletions: 1,
    };
    const lines = buildSummaryText(payload);
    const binary = lines.find((l) => l.includes("logs_2.sqlite-wal"))!;
    assert.ok(binary.includes("(no diff — file too large/binary or snapshot missing)"));
    assert.ok(!lines.some((l) => l.includes("readme.txt") && l.includes("no diff")), "diffable shell change keeps no marker");
  });

  it("renders the Chinese no-diff marker", () => {
    const payload: SummaryPayload = {
      entries: [
        { kind: "file", path: "logs_2.sqlite-wal", status: "M", insertions: 0, deletions: 0, fileCount: 1, source: "shell", noDiff: true },
      ],
      totalFiles: 1,
      totalInsertions: 0,
      totalDeletions: 0,
    };
    const lines = buildSummaryText(payload, undefined, zhMessages);
    assert.ok(lines.some((l) => l.includes("(无 diff — 文件过大/二进制或快照缺失)")));
  });
});

describe("buildPayload no-diff detection", () => {
  it("flags bash changes without a diff as noDiff", () => {
    const payload = buildPayload(
      [
        change({ path: "/work/proj/wal.sqlite-wal", kind: "bash", insertions: 0, deletions: 0 }),
        change({ path: "/work/proj/txt.log", kind: "bash", insertions: 2, deletions: 0, bashDiff: "--- a\n+++ b\n@@ -1,1 +1,1 @@\n-a\n+b\n" }),
      ],
      idPath,
    )!;
    const byPath = new Map(payload.entries.map((e) => [e.path, e.noDiff]));
    assert.equal(byPath.get("wal.sqlite-wal"), true);
    assert.equal(byPath.get("txt.log"), false);
  });
});

describe("dirStatuses baseline-derived directory status", () => {
  it("existing dir that only gained files renders as M with an added composition", () => {
    const payload = buildPayload(
      Array.from({ length: 6 }, (_, i) =>
        change({ path: `/work/proj/src/n${i}.ts`, kind: "write", insertions: 1, deletions: 0, content: "x\n" }),
      ),
      idPath,
      null,
      undefined,
      5,
      new Map([["src", "M"]]),
    )!;
    const line = buildSummaryText(payload).find((l) => l.includes("src/"))!;
    assert.ok(line.startsWith("M src/"), "existing dir gains M even when every file is new");
    assert.ok(line.includes("(6 files added)"), "composition still lists the additions");
  });

  it("removed dir with all-deleted files renders as D", () => {
    const payload = buildPayload(
      Array.from({ length: 6 }, (_, i) =>
        change({ path: `/work/proj/src/n${i}.ts`, kind: "bash", insertions: 0, deletions: 2, fileStatus: "D" }),
      ),
      idPath,
      null,
      undefined,
      5,
      new Map([["src", "D"]]),
    )!;
    const line = buildSummaryText(payload).find((l) => l.includes("src/"))!;
    assert.ok(line.startsWith("- "), "deleted dir keeps the minus icon");
    assert.ok(line.includes("(6 files deleted)"));
  });
});

describe("splitPatchLines jsdiff format", () => {
  it("filters Index:/==== decoration lines", () => {
    const patch = [
      "Index: /tmp/x/f.txt",
      "===================================================================",
      "--- /tmp/x/f.txt",
      "+++ /tmp/x/f.txt",
      "@@ -0,0 +1,1 @@",
      "+newfile",
    ].join("\n");
    const { lines } = splitPatchLines(patch, 12);
    assert.deepEqual(lines, ["@@ -0,0 +1,1 @@", "+newfile"]);
  });
});

describe("buildSummaryText file-level status", () => {
  it("marks added/deleted files (default English)", () => {
    const payload: SummaryPayload = {
      entries: [
        { kind: "file", path: "new.ts", status: "A", insertions: 3, deletions: 0, fileCount: 1 },
        { kind: "file", path: "old.ts", status: "D", insertions: 0, deletions: 5, fileCount: 1, source: "shell" },
        { kind: "file", path: "mod.ts", status: "M", insertions: 1, deletions: 1, fileCount: 1 },
      ],
      totalFiles: 3,
      totalInsertions: 4,
      totalDeletions: 6,
    };
    const lines = buildSummaryText(payload);
    const added = lines.find((l) => l.includes("new.ts"))!;
    assert.ok(added.startsWith("+ new.ts"));
    assert.ok(added.includes("(new file)"));
    const deleted = lines.find((l) => l.includes("old.ts"))!;
    assert.ok(deleted.startsWith("- "));
    assert.ok(deleted.includes("\x1b[9mold.ts\x1b[29m"), "filename should be struck through");
    assert.ok(deleted.includes("(deleted)"));
    const modified = lines.find((l) => l.includes("mod.ts"))!;
    assert.ok(modified.startsWith("M mod.ts"));
    assert.ok(!modified.includes("new file") && !modified.includes("deleted"));
  });

  it("renders Chinese when zhMessages is passed", () => {
    const payload: SummaryPayload = {
      entries: [
        { kind: "file", path: "new.ts", status: "A", insertions: 3, deletions: 0, fileCount: 1 },
        { kind: "file", path: "old.ts", status: "D", insertions: 0, deletions: 5, fileCount: 1, source: "shell" },
        { kind: "dir", path: "docs", status: "A", insertions: 9, deletions: 0, fileCount: 6, counts: { A: 6, D: 0, M: 0 } },
      ],
      totalFiles: 8,
      totalInsertions: 12,
      totalDeletions: 5,
    };
    const lines = buildSummaryText(payload, undefined, zhMessages);
    assert.equal(lines[0], "8 个文件改动  +12  -5");
    assert.ok(lines.some((l) => l.includes("(新文件)")));
    assert.ok(lines.some((l) => l.includes("(已删除)")));
    assert.ok(lines.some((l) => l.includes("(新增 6 个文件)")));
    assert.ok(lines.some((l) => l.includes("[ctrl+q] 打开面板")));
    assert.ok(lines.some((l) => l.includes("/file-diff 查看会话全量改动")));
  });
});

describe("withGreenSuccess", () => {
  it("overrides success with a fixed green and passes other colors through", async () => {
    const { withGreenSuccess } = await import("../colors.ts");
    const themeFg = (color: string, text: string) => `<${color}>${text}</>`;
    const fg = withGreenSuccess(themeFg as never);
    assert.equal(fg("success", "+x"), "\x1b[38;2;96;200;112m+x");
    assert.equal(fg("error", "-x"), "<error>-x</>");
    assert.equal(fg("dim", "p"), "<dim>p</>");
  });
});

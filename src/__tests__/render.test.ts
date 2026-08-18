import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPayload,
  buildSummaryText,
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
      payload.files.map((f) => [f.file, f.status, f.kind]),
      [
        ["e.ts", "M", "edit"],
        ["n.ts", "A", "write"],
        ["s.ts", "M", "bash"],
      ],
    );
  });

  it("does not embed diff bodies in the payload (kept for the panel)", () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n";
    const payload = buildPayload(
      [change({ kind: "edit", patch, insertions: 1, deletions: 1 })],
      idPath,
    )!;
    assert.equal("diffLines" in payload.files[0]!, false);
    assert.equal(payload.files[0]!.insertions, 1);
  });

  it("caps files at MAX_FILES", () => {
    const changes = Array.from({ length: MAX_FILES + 5 }, (_, i) =>
      change({ path: `/work/proj/f${i}.ts`, kind: "edit", insertions: 1, deletions: 0 }),
    );
    const payload = buildPayload(changes, idPath)!;
    assert.equal(payload.files.length, MAX_FILES);
    assert.equal(payload.totalFiles, MAX_FILES + 5);
  });
});

describe("buildSummaryText", () => {
  const payload: SummaryPayload = {
    files: [
      { file: "src/a.ts", status: "M", kind: "edit", insertions: 2, deletions: 1 },
      { file: "n.ts", status: "A", kind: "write", insertions: 2, deletions: 0 },
      { file: "s.ts", status: "M", kind: "bash", insertions: 0, deletions: 0 },
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
    assert.ok(lines.some((l) => l.startsWith("~ src/a.ts  +2 -1")));
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

  it("shows overflow summary for large changesets", () => {
    const many: SummaryPayload = {
      files: Array.from({ length: MAX_FILES }, (_, i) => ({
        file: `f${i}.ts`,
        status: "M" as const,
        kind: "edit" as const,
        insertions: 1,
        deletions: 0,
      })),
      totalFiles: MAX_FILES + 7,
      totalInsertions: 1,
      totalDeletions: 0,
    };
    const lines = buildSummaryText(many);
    assert.ok(lines.some((l) => l === `... and 7 more`));
  });

  it("handles empty diff-less entries gracefully", () => {
    const empty: SummaryPayload = {
      files: [{ file: "x.ts", status: "M", kind: "bash", insertions: 0, deletions: 0 }],
      totalFiles: 1,
      totalInsertions: 0,
      totalDeletions: 0,
    };
    const lines = buildSummaryText(empty);
    assert.equal(lines[0], "1 file changed");
    assert.equal(lines[1], "~ x.ts (shell)");
  });
});

describe("isSummaryPayload", () => {
  it("accepts valid payloads and rejects garbage", () => {
    assert.equal(isSummaryPayload({ files: [], totalFiles: 0 }), true);
    assert.equal(isSummaryPayload(null), false);
    assert.equal(isSummaryPayload("nope"), false);
    assert.equal(isSummaryPayload({ files: "x" }), false);
    assert.equal(isSummaryPayload({}), false);
  });
});

describe("buildSummaryText shellTouched", () => {
  it("marks files that were shell-modified after tracking", () => {
    const payload: SummaryPayload = {
      files: [
        { file: "a.txt", status: "M", kind: "edit", insertions: 1, deletions: 1, shellTouched: true },
        { file: "b.txt", status: "A", kind: "write", insertions: 2, deletions: 0 },
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
  it("groups files into tracked and untracked sections", () => {
    const payload: SummaryPayload = {
      files: [
        { file: "src/a.ts", status: "M", kind: "edit", insertions: 1, deletions: 1, tracked: true },
        { file: "gen.txt", status: "M", kind: "bash", insertions: 0, deletions: 0, tracked: false },
        { file: "new.ts", status: "A", kind: "write", insertions: 2, deletions: 0, tracked: false },
      ],
      totalFiles: 3,
      totalInsertions: 3,
      totalDeletions: 1,
    };
    const lines = buildSummaryText(payload);
    const ti = lines.findIndex((l) => l === "git tracked files:");
    const ui = lines.findIndex((l) => l === "git untracked files:");
    assert.ok(ti >= 0 && ui > ti, "tracked section must come first");
    assert.ok(lines.slice(ti + 1, ui).some((l) => l.startsWith("~ src/a.ts")));
    assert.ok(lines.slice(ui + 1).some((l) => l.startsWith("~ gen.txt")));
    assert.ok(lines.slice(ui + 1).some((l) => l.startsWith("+ new.ts")));
  });

  it("skips empty sections", () => {
    const payload: SummaryPayload = {
      files: [{ file: "a.ts", status: "M", kind: "edit", insertions: 1, deletions: 0, tracked: true }],
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
      files: [{ file: "a.ts", status: "M", kind: "edit", insertions: 1, deletions: 0 }],
      totalFiles: 1,
      totalInsertions: 1,
      totalDeletions: 0,
    };
    const lines = buildSummaryText(payload);
    assert.ok(!lines.some((l) => l.startsWith("git ")));
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
      files: [
        { file: "new.ts", status: "A", kind: "write", insertions: 3, deletions: 0 },
        { file: "old.ts", status: "D", kind: "bash", insertions: 0, deletions: 5 },
        { file: "mod.ts", status: "M", kind: "edit", insertions: 1, deletions: 1 },
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
    assert.ok(modified.startsWith("~ mod.ts"));
    assert.ok(!modified.includes("new file") && !modified.includes("deleted"));
  });

  it("renders Chinese when zhMessages is passed", () => {
    const payload: SummaryPayload = {
      files: [
        { file: "new.ts", status: "A", kind: "write", insertions: 3, deletions: 0 },
        { file: "old.ts", status: "D", kind: "bash", insertions: 0, deletions: 5 },
      ],
      totalFiles: 2,
      totalInsertions: 3,
      totalDeletions: 5,
    };
    const lines = buildSummaryText(payload, undefined, zhMessages);
    assert.equal(lines[0], "2 个文件改动  +3  -5");
    assert.ok(lines.some((l) => l.includes("(新文件)")));
    assert.ok(lines.some((l) => l.includes("(已删除)")));
    assert.ok(lines.some((l) => l.includes("[ctrl+q] 查看单个文件 diff")));
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

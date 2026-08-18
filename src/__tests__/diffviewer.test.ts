import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-tui";
import {
  buildDiffViewLines,
  FileDiffPanel,
  MouseWheelParser,
  parseNumberedLines,
  type PanelFile,
} from "../diffviewer.ts";
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

const fakeTheme = {
  fg: (color: string, text: string) => `<${color}>${text}</>`,
} as unknown as Theme;

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

function makeKeys(): KeybindingsManager {
  const map: Record<string, string> = {
    [UP]: "tui.select.up",
    [DOWN]: "tui.select.down",
    ["\x1b[5~"]: "tui.select.pageUp",
    ["\x1b[6~"]: "tui.select.pageDown",
    [ENTER]: "tui.select.confirm",
    [ESC]: "tui.select.cancel",
  };
  return { matches: (data: string, id: string) => map[data] === id } as unknown as KeybindingsManager;
}

function makePanel(files: PanelFile[]) {
  const events: string[] = [];
  const panel = new FileDiffPanel(
    files,
    fakeTheme,
    makeKeys(),
    () => events.push("render"),
    () => events.push("done"),
    new EventEmitter(), // never touch the real process.stdin in tests
  );
  return { panel, events };
}

/** Panels wired to a fake emitter instead of the real process.stdin. */
function makeMousePanel(files: PanelFile[]) {
  const mouse = new EventEmitter();
  const events: string[] = [];
  const panel = new FileDiffPanel(
    files,
    fakeTheme,
    makeKeys(),
    () => events.push("render"),
    () => events.push("done"),
    mouse,
  );
  return { panel, events, mouse };
}

function sampleFiles(): PanelFile[] {
  return [
    {
      path: "src/a.ts",
      change: change({
        path: "/work/proj/src/a.ts",
        kind: "edit",
        insertions: 2,
        deletions: 1,
        patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,3 +1,4 @@\n-old\n+new\n+new2\n ctx\n",
      }),
    },
    {
      path: "src/new.ts",
      change: change({
        path: "/work/proj/src/new.ts",
        kind: "write",
        insertions: 2,
        deletions: 0,
        content: "a\nb\n",
      }),
    },
    {
      path: "data.json",
      change: change({ path: "/work/proj/data.json", kind: "bash", insertions: 0, deletions: 0 }),
    },
  ];
}

describe("MouseWheelParser", () => {
  it("parses wheel up and wheel down", () => {
    const p = new MouseWheelParser();
    assert.equal(p.push("\x1b[<64;10;10M"), -1);
    assert.equal(p.push("\x1b[<65;10;10M"), 1);
  });

  it("handles sequences split across chunks", () => {
    const p = new MouseWheelParser();
    assert.equal(p.push("\x1b[<6"), 0); // partial
    assert.equal(p.push("4;10;10M"), -1); // rest
  });

  it("ignores button presses, releases, and garbage", () => {
    const p = new MouseWheelParser();
    assert.equal(p.push("\x1b[<0;10;10M"), 0); // left click
    assert.equal(p.push("\x1b[<64;10;10m"), 0); // wheel up release
    assert.equal(p.push("hello"), 0);
    assert.equal(p.push("\x1b"), 0);
  });

  it("accumulates multiple events in one chunk", () => {
    const p = new MouseWheelParser();
    assert.equal(p.push("\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M"), -1);
  });

  it("drops stale pending data when garbage arrives", () => {
    const p = new MouseWheelParser();
    p.push("\x1b[<6"); // partial
    p.push("x".repeat(80)); // garbage flood
    assert.equal(p.push("\x1b[<65;1;1M"), 1); // still parses fresh events
  });
});

describe("buildDiffViewLines", () => {
  it("colors patch lines with line numbers: + green, - red, context dim", () => {
    const lines = buildDiffViewLines(
      change({
        kind: "edit",
        patch: "--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-a\n+b\n ctx\n",
      }),
      (c, t) => `<${c}>${t}</>`,
    );
    assert.deepEqual(lines, [
      "<dim>    │ @@ -1,3 +1,3 @@</>",
      "<error>1 - │ a</>",
      "<success>1 + │ b</>",
      "<dim>2   │ ctx</>",
    ]);
  });

  it("keeps diff markers in a dedicated gutter, outside source text", () => {
    const lines = buildDiffViewLines(
      change({ kind: "edit", patch: "--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-old\n+new\n" }),
      (_c, t) => t,
    );

    assert.ok(lines.includes("1 - │ old"));
    assert.ok(lines.includes("1 + │ new"));
    assert.ok(!lines.some((line) => line.includes("│ -old") || line.includes("│ +new")));
  });

  it("shows a ⋯ gap between non-adjacent line numbers", () => {
    const patch = [
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,2 @@",
      " a",
      " b",
      "@@ -20,3 +20,3 @@",
      "-x",
      "+y",
      " z",
    ].join("\n");
    const lines = buildDiffViewLines(change({ kind: "edit", patch }), (_c, t) => t);
    assert.ok(lines.some((line) => line.includes("│ ⋯")), "gap marker between hunk blocks");
    // line numbers: first hunk ends at new line 2, next hunk starts at 20.
    // The gap renders after the second @@ header, before the first content.
    const gapIdx = lines.findIndex((line) => line.includes("│ ⋯"));
    assert.ok(lines[gapIdx - 1]!.includes("@@ -20"), "gap follows the hunk header");
    assert.ok(lines[gapIdx - 2]!.includes(" 2   │ b"), "previous content line numbered 2");
    assert.ok(lines[gapIdx + 1]!.includes("20 - │ x"), "next - line numbered 20");
  });

  it("no gap for adjacent replacement lines", () => {
    const lines = buildDiffViewLines(
      change({ kind: "edit", patch: "--- a/x\n+++ b/x\n@@ -5,1 +5,1 @@\n-old\n+new\n" }),
      (_c, t) => t,
    );
    assert.ok(!lines.some((l) => l.includes("⋯")));
    assert.ok(lines.some((l) => l.includes("5 - │ old")));
    assert.ok(lines.some((l) => l.includes("5 + │ new")));
  });

  it("numbers write content lines consecutively with + prefix", () => {
    const lines = buildDiffViewLines(
      change({ kind: "write", content: "a\nb\nc\n" }),
      (c, t) => `<${c}>${t}</>`,
    );
    assert.deepEqual(lines, ["<success>1 + │ a</>", "<success>2 + │ b</>", "<success>3 + │ c</>"]);
  });

  it("shows placeholder for shell changes", () => {
    const lines = buildDiffViewLines(change({ kind: "bash" }), (c, t) => `<${c}>${t}</>`);
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /shell/);
  });
});

describe("parseNumberedLines", () => {
  it("tracks old/new cursors across hunks", () => {
    const patch = [
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +10,2 @@",
      " a",
      "-del",
      "+add",
      " b",
    ].join("\n");
    const lines = parseNumberedLines(patch);
    assert.deepEqual(
      lines.map((l) => [l.text, l.oldLine, l.newLine]),
      [
        ["@@ -1,2 +10,2 @@", undefined, undefined],
        [" a", 1, 10],
        ["-del", 2, undefined],
        ["+add", undefined, 11],
        [" b", 3, 12],
      ],
    );
  });

  it("drops patch headers", () => {
    const patch = "Index: /tmp/x\n====\n--- a/x\n+++ b/x\n@@ -0,0 +1,1 @@\n+n\n";
    const lines = parseNumberedLines(patch);
    assert.equal(lines.length, 2); // @@ + content only
  });
});

describe("FileDiffPanel", () => {
  it("renders list view with header, files, and hint", () => {
    const { panel } = makePanel(sampleFiles());
    const out = panel.render(80);
    assert.match(out[0]!, /pi-file-diff · 3 files changed/);
    assert.ok(out.some((l) => l.includes("src/a.ts")));
    assert.ok(out.some((l) => l.includes("(shell)")));
    assert.ok(out.some((l) => l.includes("Esc: close")));
  });

  it("pads an overlay panel to the viewport height, hiding background content", () => {
    const panel = new FileDiffPanel(
      sampleFiles(),
      fakeTheme,
      makeKeys(),
      () => {},
      () => {},
      new EventEmitter(),
      undefined,
      () => 12,
    );

    const out = panel.render(80);
    assert.equal(out.length, 12);
    assert.ok(out.some((line) => line.includes("pi-file-diff")));
    assert.ok(out.slice(5).every((line) => line === ""), "remaining viewport rows are opaque blanks");
    panel.dispose();
  });

  it("highlights the selected line with reverse video", () => {
    const { panel } = makePanel(sampleFiles());
    const out = panel.render(80);
    assert.ok(out.some((l) => l.includes("\x1b[7m")));
    assert.equal(out.filter((l) => l.includes("\x1b[7m")).length, 1);
  });

  it("groups interleaved tracked and untracked files into one section each", () => {
    const { panel } = makePanel([
      { path: "new-first.ts", tracked: false, change: change({ firstTouchedAt: 1 }) },
      { path: "tracked-first.ts", tracked: true, change: change({ firstTouchedAt: 2 }) },
      { path: "new-second.ts", tracked: false, change: change({ firstTouchedAt: 3 }) },
      { path: "tracked-second.ts", tracked: true, change: change({ firstTouchedAt: 4 }) },
    ]);

    const out = panel.render(80);
    const trackedHeader = "git tracked files:";
    const untrackedHeader = "git untracked files:";
    assert.equal(out.filter((line) => line.includes(trackedHeader)).length, 1);
    assert.equal(out.filter((line) => line.includes(untrackedHeader)).length, 1);

    const position = (path: string) => out.findIndex((line) => line.includes(path));
    assert.ok(position("tracked-first.ts") < position("tracked-second.ts"), "tracked order stays stable");
    assert.ok(position("tracked-second.ts") < position("new-first.ts"), "tracked section renders first");
    assert.ok(position("new-first.ts") < position("new-second.ts"), "untracked order stays stable");
  });

  it("moves selection with arrow keys", () => {
    const { panel, events } = makePanel(sampleFiles());
    panel.handleInput(DOWN); // -> src/new.ts
    assert.equal(events.filter((e) => e === "render").length, 1);
    const out = panel.render(80);
    const selected = out.find((l) => l.includes("\x1b[7m"))!;
    assert.ok(selected.includes("src/new.ts"));
  });

  it("clamps selection at both ends", () => {
    const { panel } = makePanel(sampleFiles());
    panel.handleInput(UP);
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    panel.handleInput(DOWN);
    const out = panel.render(80);
    const selected = out.find((l) => l.includes("\x1b[7m"))!;
    assert.ok(selected.includes("data.json"));
  });

  it("enter opens diff view with colored lines, esc returns", () => {
    const { panel } = makePanel(sampleFiles());
    panel.handleInput(DOWN); // -> src/new.ts (write)
    panel.handleInput(ENTER); // open diff
    const out = panel.render(80);
    assert.match(out[0]!, /src\/new.ts/);
    assert.ok(out.some((l) => l.includes("\x1b[38;2;96;200;112m1 + │ a")), "added lines render in fixed green");

    panel.handleInput(ESC);
    const list = panel.render(80);
    assert.ok(list.some((l) => l.includes("pi-file-diff")));
  });

  it("diff view scrolls and clamps", () => {
    const bigPatch = [
      "--- a/x",
      "+++ b/x",
      ...Array.from({ length: 60 }, (_, i) => (i % 2 ? `+l${i}` : `-l${i}`)),
    ].join("\n");
    const { panel } = makePanel([
      { path: "big.ts", change: change({ kind: "edit", patch: bigPatch }) },
    ]);
    panel.handleInput(ENTER);
    for (let i = 0; i < 50; i++) panel.handleInput(DOWN);
    const out = panel.render(80);
    // scrolled to the tail: footer shows position info
    assert.ok(out.some((l) => l.includes("/ 60")));
  });

  it("enter in diff view closes the panel", () => {
    const { panel, events } = makePanel(sampleFiles());
    panel.handleInput(ENTER); // open diff
    panel.handleInput(ENTER); // close
    assert.ok(events.includes("done"));
  });

  it("responds to mouse wheel events", () => {
    const { panel, mouse } = makeMousePanel(sampleFiles());
    mouse.emit("data", Buffer.from("\x1b[<65;10;10M")); // wheel down
    mouse.emit("data", Buffer.from("\x1b[<64;10;10M")); // wheel up
    const out = panel.render(80);
    const selected = out.find((l) => l.includes("\x1b[7m"))!;
    assert.ok(selected.includes("src/a.ts")); // down then up -> back to first
  });

  it("wheel in diff view scrolls instead of changing selection", () => {
    const bigPatch = [
      "--- a/x",
      "+++ b/x",
      ...Array.from({ length: 60 }, (_, i) => `+l${i}`),
    ].join("\n");
    const { panel, mouse } = makeMousePanel([
      { path: "big.ts", change: change({ kind: "edit", patch: bigPatch }) },
    ]);
    panel.handleInput(ENTER); // diff view
    mouse.emit("data", Buffer.from("\x1b[<65;10;10M")); // wheel down
    const out = panel.render(80);
    assert.ok(out.some((l) => l.includes("/ 60")));
  });

  it("dispose detaches the mouse listener", () => {
    const { panel, mouse } = makeMousePanel(sampleFiles());
    const listenerCount = mouse.listenerCount("data");
    panel.dispose();
    assert.equal(mouse.listenerCount("data"), listenerCount - 1);
    mouse.emit("data", Buffer.from("\x1b[<65;10;10M")); // no crash after detach
  });
});

describe("FileDiffPanel pagination", () => {
  function manyFiles(n: number): PanelFile[] {
    return Array.from({ length: n }, (_, i) => ({
      path: `f${i}.ts`,
      change: change({ path: `/work/proj/f${i}.ts`, kind: "edit", insertions: 1, deletions: 0 }),
    }));
  }

  it("shows page indicator and a page worth of files", () => {
    const { panel } = makePanel(manyFiles(25));
    const out = panel.render(80);
    assert.ok(out.some((l) => l.includes("Page 1/3")));
    // page 1 shows first 10 files
    assert.ok(out.some((l) => l.includes("f0.ts")));
    assert.ok(out.some((l) => l.includes("f9.ts")));
    assert.ok(!out.some((l) => l.includes("f10.ts")));
  });

  it("page down jumps to the next page", () => {
    const { panel } = makePanel(manyFiles(25));
    panel.handleInput("\x1b[6~"); // page down
    const out = panel.render(80);
    assert.ok(out.some((l) => l.includes("Page 2/3")));
    const selected = out.find((l) => l.includes("\x1b[7m"))!;
    assert.ok(selected.includes("f10.ts"), "selection lands on first item of new page");
  });

  it("clamps page navigation at both ends", () => {
    const { panel } = makePanel(manyFiles(25));
    panel.handleInput("\x1b[6~");
    panel.handleInput("\x1b[6~");
    panel.handleInput("\x1b[6~");
    panel.handleInput("\x1b[6~");
    assert.ok(panel.render(80).some((l) => l.includes("Page 3/3")));
    panel.handleInput("\x1b[5~");
    panel.handleInput("\x1b[5~");
    panel.handleInput("\x1b[5~");
    assert.ok(panel.render(80).some((l) => l.includes("Page 1/3")));
  });

  it("selection crossing a page boundary flips the page", () => {
    const { panel } = makePanel(manyFiles(12));
    for (let i = 0; i < 9; i++) panel.handleInput(DOWN); // -> f9 (last of page 1)
    assert.ok(panel.render(80).some((l) => l.includes("Page 1/2")));
    panel.handleInput(DOWN); // -> f10 -> page 2
    assert.ok(panel.render(80).some((l) => l.includes("Page 2/2")));
  });
});

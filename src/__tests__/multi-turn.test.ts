/**
 * Multi-turn integration scenarios — mixed built-in tools (write/edit) and
 * bash across turns, mirroring real conversations. Each test simulates a
 * sequence of turns on a fresh workspace and asserts the tracker state a
 * summary would be built from (mutation counting = "did this turn change
 * something", diff freshness, kind transitions, status).
 *
 * Time model: each turn advances a simulated clock by 10s; files written
 * during a turn get that turn's mtime (utimes). The end-of-turn scan uses
 * the turn's start time, so files from earlier turns fall outside the
 * mtime window (+1s guard) and are not re-detected.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChangeTracker, type TrackedChange } from "../tracker.ts";

let dir: string;
let tracker: ChangeTracker;
let snapshot: Map<string, string>;
/** Contents recorded right after write/edit tools (as the extension does). */
let toolContents: Map<string, string>;
/** Simulated clock: current turn's start time. */
let now: number;
let turnIndex: number;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-file-diff-multi-"));
  tracker = new ChangeTracker(dir);
  snapshot = new Map();
  toolContents = new Map();
  now = Date.now();
  turnIndex = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Advance to the next turn; returns the new turn's start time. */
function nextTurn(): number {
  turnIndex++;
  now += 10_000;
  return now;
}

/** Advance the clock within a turn (so a bash write gets a distinct mtime). */
function advanceClock(ms = 1_000): void {
  now += ms;
}

/** Write a file with the current turn's mtime. */
async function writeAt(path: string, content: string): Promise<void> {
  await writeFile(path, content);
  await utimes(path, new Date(now), new Date(now));
}

/** End-of-turn bash scan + knownContent refresh against the given start time. */
async function endTurn(turnStart: number): Promise<void> {
  await tracker.collectBashChanges(turnStart, snapshot, toolContents);
  await tracker.refreshKnownContents();
}

/** Simulate a write tool call: record the change and the resulting mtime. */
async function toolWrite(path: string, content: string): Promise<void> {
  await writeAt(path, content);
  tracker.recordWrite(path, content);
  toolContents.set(path, content);
}

/**
 * Simulate an edit tool call: write the post-edit content, record the patch
 * and the resulting mtime. knownContent is refreshed at END of run (like the
 * real extension), not at tool time.
 */
async function toolEdit(path: string, patch: string, finalContent: string): Promise<void> {
  await writeAt(path, finalContent);
  tracker.recordEdit(path, patch);
  toolContents.set(path, finalContent);
}

const mutations = () => tracker.mutations;

function change(path: string): TrackedChange {
  return tracker.all.find((c) => c.path === path)!;
}

const P = (f: string) => join(dir, f);

describe("multi-turn: write + bash", () => {
  it("write create → noop → bash append → bash append again", async () => {
    // turn 1: write creates a.txt
    const t1 = nextTurn();
    await toolWrite(P("a.txt"), "v1\n");
    await endTurn(t1);
    const afterT1 = mutations();

    // turn 2: no file activity — must not count
    const t2 = nextTurn();
    await endTurn(t2);
    assert.equal(mutations(), afterT1, "noop turn must not count");

    // turn 3: bash appends
    const t3 = nextTurn();
    await writeAt(P("a.txt"), "v1\nv2\n");
    await endTurn(t3);
    assert.equal(mutations(), afterT1 + 1, "append must count");
    const c = change(P("a.txt"));
    assert.equal(c.kind, "write");
    assert.equal(c.shellTouched, true);
    assert.match(c.bashDiff ?? "", /\+v2/);
    const diffAfterT3 = c.bashDiff;

    // turn 4: bash appends again
    const t4 = nextTurn();
    await writeAt(P("a.txt"), "v1\nv2\nv3\n");
    await endTurn(t4);
    assert.equal(mutations(), afterT1 + 2);
    assert.match(c.bashDiff ?? "", /\+v3/);
    assert.ok(c.bashDiff !== diffAfterT3, "diff must refresh");
  });

  it("write create → bash delete → repeated scans do not re-count", async () => {
    // turn 1: write creates
    const t1 = nextTurn();
    snapshot.set(P("a.txt"), "v1\n"); // existed at conversation start too
    await toolWrite(P("a.txt"), "v1\n");
    await endTurn(t1);
    const afterT1 = mutations();

    // turn 3: bash deletes it
    const t3 = nextTurn();
    await rm(P("a.txt"));
    await endTurn(t3);
    assert.equal(mutations(), afterT1 + 1, "delete must count");
    const c = change(P("a.txt"));
    assert.equal(c.shellTouched, true);
    assert.match(c.bashDiff ?? "", /-v1/, "all-deleted diff from snapshot");

    // turn 4: still deleted, nothing new — must not count again
    const t4 = nextTurn();
    await endTurn(t4);
    assert.equal(mutations(), afterT1 + 1, "repeated delete scan must not re-count");
  });

  it("bash create → write overwrite (kind transition)", async () => {
    // turn 1: bash creates b.txt
    const t1 = nextTurn();
    await writeAt(P("b.txt"), "old\n");
    await endTurn(t1);
    const afterT1 = mutations();
    assert.equal(change(P("b.txt")).kind, "bash");
    assert.equal(afterT1, 1);

    // turn 3: write overwrites it
    const t3 = nextTurn();
    await toolWrite(P("b.txt"), "new content\n");
    await endTurn(t3);
    assert.equal(mutations(), afterT1 + 1);
    const c = change(P("b.txt"));
    assert.equal(c.kind, "write", "kind transitions to write");
    assert.equal(c.content, "new content\n");
    assert.equal(c.patch, undefined);
  });

  it("bash create → bash append → bash append again (diff refreshes each time)", async () => {
    // turn 1: bash creates
    const t1 = nextTurn();
    await writeAt(P("f.txt"), "v1\n");
    await endTurn(t1);
    const afterT1 = mutations();
    const first = change(P("f.txt")).bashDiff;

    // turn 2: bash appends
    const t2 = nextTurn();
    await writeAt(P("f.txt"), "v1\nv2\n");
    await endTurn(t2);
    assert.equal(mutations(), afterT1 + 1);
    const second = change(P("f.txt")).bashDiff;
    assert.ok(second !== first);
    assert.match(second ?? "", /\+v2/);

    // turn 3: bash appends again
    const t3 = nextTurn();
    await writeAt(P("f.txt"), "v1\nv2\nv3\n");
    await endTurn(t3);
    assert.equal(mutations(), afterT1 + 2);
    assert.match(change(P("f.txt")).bashDiff ?? "", /\+v3/);
  });

  it("bash create → bash delete (no snapshot content, flagged only)", async () => {
    // turn 1: bash creates (not in snapshot)
    const t1 = nextTurn();
    await writeAt(P("g.txt"), "temp\n");
    await endTurn(t1);
    const afterT1 = mutations();

    // turn 2: bash deletes it
    const t2 = nextTurn();
    await rm(P("g.txt"));
    await endTurn(t2);
    assert.equal(mutations(), afterT1 + 1, "delete of tracked file counts");
    const c = change(P("g.txt"));
    assert.equal(c.kind, "bash");
    assert.match(c.bashDiff ?? "", /-temp/, "all-deleted diff from known content");
  });
});

describe("multi-turn: edit + bash", () => {
  it("edit modify → bash append keeps edit kind with full snapshot diff", async () => {
    // file existed at conversation start
    snapshot.set(P("e.txt"), "line1\nline2\n");
    const t1 = nextTurn();
    await writeAt(P("e.txt"), "line1\nline2\n");
    // turn 1: edit modifies
    await toolEdit(P("e.txt"), "--- a/e.txt\n+++ b/e.txt\n@@ -1,2 +1,2 @@\n line1\n-line2\n+line2-edited\n", "line1\nline2-edited\n");
    await endTurn(t1);
    const afterT1 = mutations();

    // turn 2: bash appends
    const t2 = nextTurn();
    await writeAt(P("e.txt"), "line1\nline2-edited\nappended\n");
    await endTurn(t2);
    assert.equal(mutations(), afterT1 + 1);
    const c = change(P("e.txt"));
    assert.equal(c.kind, "edit", "edit kind preserved");
    assert.equal(c.shellTouched, true);
    assert.match(c.bashDiff ?? "", /\+appended/, "snapshot-vs-current diff includes the append");
    assert.match(c.bashDiff ?? "", /line2-edited/, "diff reflects the edited state");
  });

  it("edit → bash delete", async () => {
    snapshot.set(P("e2.txt"), "old\n");
    const t1 = nextTurn();
    await toolEdit(P("e2.txt"), "--- a/e2.txt\n+++ b/e2.txt\n@@ -1,1 +1,1 @@\n-old\n+new\n", "new\n");
    await endTurn(t1);
    const afterT1 = mutations();

    const t2 = nextTurn();
    await rm(P("e2.txt"));
    await endTurn(t2);
    assert.equal(mutations(), afterT1 + 1);
    const c = change(P("e2.txt"));
    assert.equal(c.shellTouched, true);
    assert.match(c.bashDiff ?? "", /-new/, "all-deleted diff from the latest known content (post-edit)");
  });
});

describe("multi-turn: full mixed sequences (mutation semantics)", () => {
  it("write → noop → bash append → write new file → bash append both", async () => {
    // turn 1: write a.txt
    const t1 = nextTurn();
    await toolWrite(P("a.txt"), "v1\n");
    await endTurn(t1);
    let m = mutations();

    // turn 2: noop — summary suppressed
    const t2 = nextTurn();
    await endTurn(t2);
    assert.equal(mutations(), m);

    // turn 3: bash append a.txt — summary shown
    const t3 = nextTurn();
    await writeAt(P("a.txt"), "v1\nv2\n");
    await endTurn(t3);
    m = mutations();
    assert.ok(m > 0);

    // turn 4: write new file b.txt — summary shown (only b.txt new)
    const t4 = nextTurn();
    await toolWrite(P("b.txt"), "b1\n");
    await endTurn(t4);
    const mAfterT4 = mutations();
    assert.equal(mAfterT4, m + 1, "only the write counts — a.txt unchanged this turn");

    // turn 5: bash appends to BOTH files — two mutations
    const t5 = nextTurn();
    await writeAt(P("a.txt"), "v1\nv2\nv3\n");
    await writeAt(P("b.txt"), "b1\nb2\n");
    await endTurn(t5);
    assert.equal(mutations(), mAfterT4 + 2, "two bash modifications = two mutations");
    assert.match(change(P("a.txt")).bashDiff ?? "", /\+v3/);
    assert.match(change(P("b.txt")).bashDiff ?? "", /\+b2/);
  });

  it("deleted-then-recreated file counts as a fresh change", async () => {
    // turn 1: write creates
    snapshot.set(P("r.txt"), "old\n");
    const t1 = nextTurn();
    await toolWrite(P("r.txt"), "v1\n");
    await endTurn(t1);
    const m1 = mutations();

    // turn 2: bash deletes
    const t2 = nextTurn();
    await rm(P("r.txt"));
    await endTurn(t2);
    const m2 = mutations();
    assert.equal(m2, m1 + 1);

    // turn 3: bash recreates it — a new modification
    const t3 = nextTurn();
    await writeAt(P("r.txt"), "recreated\n");
    await endTurn(t3);
    assert.equal(mutations(), m2 + 1, "recreation counts");
    assert.match(change(P("r.txt")).bashDiff ?? "", /\+recreated/);
  });

  it("several files modified across turns keep independent diffs", async () => {
    // turn 1: bash creates three files
    const t1 = nextTurn();
    for (const f of ["x1.txt", "x2.txt", "x3.txt"]) {
      await writeAt(P(f), "1\n");
    }
    await endTurn(t1);
    assert.equal(mutations(), 3);

    // turn 2: write overwrites x1, bash touches x2
    const t2 = nextTurn();
    await toolWrite(P("x1.txt"), "1\nedited\n");
    await writeAt(P("x2.txt"), "1\n2\n");
    await endTurn(t2);
    assert.equal(mutations(), 5);

    const x1 = change(P("x1.txt"));
    const x2 = change(P("x2.txt"));
    assert.equal(x1.kind, "write");
    assert.match(x2.bashDiff ?? "", /\+2/);
    assert.match(change(P("x3.txt")).bashDiff ?? "", /\+1/, "x3 untouched since creation");
  });
});

describe("multi-turn: incremental diffs (known-content baseline)", () => {
  it("write create 3 lines → bash append 3 lines shows only +3", async () => {
    const t1 = nextTurn();
    await toolWrite(P("inc.txt"), "l1\nl2\nl3\n");
    await endTurn(t1);
    const c1 = change(P("inc.txt"));
    assert.equal(c1.insertions, 3, "turn 1: 3 lines added");
    assert.match(c1.content ?? "", /l1/); // write kind shows full content

    // turn 2: bash appends 3 more lines
    const t2 = nextTurn();
    await writeAt(P("inc.txt"), "l1\nl2\nl3\nl4\nl5\nl6\n");
    await endTurn(t2);
    const c2 = change(P("inc.txt"));
    assert.equal(c2.insertions, 3, "turn 2 must count only the appended 3 lines");
    assert.equal(c2.deletions, 0);
    assert.doesNotMatch(c2.bashDiff ?? "", /\+l1/, "existing lines must not appear as additions");
    assert.match(c2.bashDiff ?? "", /\+l4/, "appended lines appear as additions");
    assert.match(c2.bashDiff ?? "", /l1/, "existing lines remain as context");
  });

  it("bash create 3 lines → bash append 3 lines → append 2 lines: always incremental", async () => {
    const t1 = nextTurn();
    await writeAt(P("b3.txt"), "a\nb\nc\n");
    await endTurn(t1);
    assert.equal(change(P("b3.txt")).insertions, 3);

    const t2 = nextTurn();
    await writeAt(P("b3.txt"), "a\nb\nc\nd\ne\nf\n");
    await endTurn(t2);
    const c2 = change(P("b3.txt"));
    assert.equal(c2.insertions, 3, "second turn adds 3");
    assert.match(c2.bashDiff ?? "", /\+d/);
    assert.doesNotMatch(c2.bashDiff ?? "", /\+a/);

    const t3 = nextTurn();
    await writeAt(P("b3.txt"), "a\nb\nc\nd\ne\nf\ng\nh\n");
    await endTurn(t3);
    const c3 = change(P("b3.txt"));
    assert.equal(c3.insertions, 2, "third turn adds 2");
    assert.match(c3.bashDiff ?? "", /\+g/);
    assert.doesNotMatch(c3.bashDiff ?? "", /\+a/);
  });

  it("edit then bash append: diff shows only the append (incremental)", async () => {
    snapshot.set(P("e3.txt"), "base\n");
    const t1 = nextTurn();
    await toolEdit(P("e3.txt"), "--- a/e3.txt\n+++ b/e3.txt\n@@ -1,1 +1,1 @@\n-base\n+edited\n", "edited\n");
    await endTurn(t1);

    const t2 = nextTurn();
    await writeAt(P("e3.txt"), "edited\nappended\n");
    await endTurn(t2);
    const c = change(P("e3.txt"));
    assert.equal(c.kind, "edit", "edit kind preserved");
    assert.equal(c.insertions, 1, "only the appended line counts");
    assert.match(c.bashDiff ?? "", /\+appended/);
    assert.doesNotMatch(c.bashDiff ?? "", /\+edited/, "edited line is context, not an addition");
    assert.match(c.bashDiff ?? "", / edited/, "edited line appears as context");
  });

  it("write → bash append → write overwrite → bash append: known content follows every step", async () => {
    const t1 = nextTurn();
    await toolWrite(P("chain.txt"), "1\n");
    await endTurn(t1);

    const t2 = nextTurn();
    await writeAt(P("chain.txt"), "1\n2\n");
    await endTurn(t2);
    assert.equal(change(P("chain.txt")).insertions, 1, "append adds 1");

    const t3 = nextTurn();
    await toolWrite(P("chain.txt"), "fresh\n");
    await endTurn(t3);
    const afterWrite = change(P("chain.txt"));
    assert.equal(afterWrite.kind, "write");
    assert.equal(afterWrite.insertions, 1, "overwrite shows its content");

    const t4 = nextTurn();
    await writeAt(P("chain.txt"), "fresh\nmore\n");
    await endTurn(t4);
    const c = change(P("chain.txt"));
    assert.equal(c.insertions, 1, "append after overwrite adds 1");
    assert.match(c.bashDiff ?? "", /\+more/);
    assert.doesNotMatch(c.bashDiff ?? "", /\+fresh/, "overwritten content is not re-added");
  });

  it("stats accumulate across turns while each diff stays incremental", async () => {
    const t1 = nextTurn();
    await toolWrite(P("acc.txt"), "1\n2\n");
    await endTurn(t1);

    const t2 = nextTurn();
    await writeAt(P("acc.txt"), "1\n2\n3\n4\n");
    await endTurn(t2);
    const c2 = change(P("acc.txt"));
    assert.equal(c2.insertions, 2);
    // the total displayed on the summary line is the running sum
    const payload = (await import("../render.ts")).buildPayload(
      tracker.all,
      (abs) => abs.replace(dir + "/", ""),
    );
    assert.equal(payload!.totalInsertions, 2, "summary total reflects the latest incremental deltas");
  });
});

describe("multi-turn: mixed add/delete/modify and same-turn delete+recreate", () => {
  it("bash modify+delete+add in one shot: stats and diff are exact", async () => {
    // baseline known content: 5 lines
    const t1 = nextTurn();
    await writeAt(P("mix.txt"), "l1\nl2\nl3\nl4\nl5\n");
    await endTurn(t1);
    assert.equal(change(P("mix.txt")).insertions, 5);

    // turn 2: bash rewrites the file with a mixed edit:
    // l2 modified, l3 deleted, l5 deleted, l6+l7 added
    const t2 = nextTurn();
    await writeAt(P("mix.txt"), "l1\nl2-modified\nl4\nl6\nl7\n");
    await endTurn(t2);

    const c = change(P("mix.txt"));
    assert.equal(c.insertions, 3, "added: l2-modified, l6, l7");
    assert.equal(c.deletions, 3, "deleted: l2, l3, l5");
    assert.match(c.bashDiff ?? "", /-l3/, "pure deletion in the diff");
    assert.match(c.bashDiff ?? "", /\+l6/, "pure addition in the diff");
    assert.match(c.bashDiff ?? "", /-l2\n\+l2-modified|-\s*l2/, "modification pair present");

    // render: additions green, deletions red, context dim
    const { buildDiffViewLines } = await import("../diffviewer.ts");
    const rendered = buildDiffViewLines(c, (color, text) => `<${color}>${text}</>`);
    assert.ok(rendered.some((l) => l.includes("<success>") && l.includes("+ │ l6")), "addition rendered green");
    assert.ok(rendered.some((l) => l.includes("<error>") && l.includes("- │ l3")), "deletion rendered red");
    assert.ok(rendered.some((l) => l.includes("<dim>") && l.includes(" l1")), "context rendered dim");
    assert.ok(rendered.some((l) => l.includes(" l1")), "context line keeps its number");
  });

  it("same turn: bash modify → delete → recreate with different content equals only modify-2", async () => {
    // previous turn left the file as "v1"
    const t1 = nextTurn();
    await writeAt(P("cycle.txt"), "v1\n");
    await endTurn(t1);
    const afterT1 = mutations();
    const first = change(P("cycle.txt")).bashDiff;

    // turn 2: bash modifies to mod1, deletes, recreates as mod2 — final = mod2
    const t2 = nextTurn();
    await writeAt(P("cycle.txt"), "mod2\n");
    await endTurn(t2);

    const c = change(P("cycle.txt"));
    assert.equal(mutations(), afterT1 + 1, "one real change despite the churn");
    assert.equal(c.kind, "bash");
    assert.ok(c.bashDiff !== first, "diff refreshed");
    // equivalent to a single v1 → mod2 modification
    assert.match(c.bashDiff ?? "", /-v1/, "old content removed");
    assert.match(c.bashDiff ?? "", /\+mod2/, "final content added");
    assert.doesNotMatch(c.bashDiff ?? "", /mod1/, "intermediate state must not leak");
    assert.equal(c.insertions, 1);
    assert.equal(c.deletions, 1);
  });

  it("same turn: edit modify-1 → bash delete → write modify-2 collapses to the write", async () => {
    // previous turn: write v1
    const t1 = nextTurn();
    await toolWrite(P("toolcycle.txt"), "v1\n");
    await endTurn(t1);

    // turn 2: edit → v1 becomes mod1; bash deletes the file; write recreates as mod2
    const t2 = nextTurn();
    await toolEdit(P("toolcycle.txt"), "--- a/toolcycle.txt\n+++ b/toolcycle.txt\n@@ -1,1 +1,1 @@\n-v1\n+mod1\n", "mod1\n");
    await rm(P("toolcycle.txt"));
    await toolWrite(P("toolcycle.txt"), "mod2\n");
    await endTurn(t2);

    const c = change(P("toolcycle.txt"));
    assert.equal(c.kind, "write", "final write wins");
    assert.equal(c.content, "mod2\n");
    assert.equal(c.shellTouched, undefined, "no shell flag — the write is the last op");
    assert.equal(c.bashDiff, undefined);
    assert.equal(c.insertions, 1, "only mod2 counts");
    assert.equal(tracker.size, 1, "single entry, no duplicate");
  });

  it("same turn: delete then recreate via bash keeps fileStatus consistent", async () => {
    // file existed at conversation start and at run start
    snapshot.set(P("stat.txt"), "orig\n");
    const t1 = nextTurn();
    await writeAt(P("stat.txt"), "orig\n");
    await endTurn(t1);

    // turn 2: bash deletes and recreates with new content
    const t2 = nextTurn();
    await writeAt(P("stat.txt"), "reborn\n");
    await endTurn(t2);
    await tracker.resolveFileStatuses(new Set([P("stat.txt")])); // run baseline: existed

    const c = change(P("stat.txt"));
    assert.equal(c.fileStatus, "M", "file exists at run start and now → modified");
    assert.match(c.bashDiff ?? "", /-orig/, "diff vs previous known content");
    assert.match(c.bashDiff ?? "", /\+reborn/);
  });
});

describe("multi-turn: edit-tool deletion + bash edit stays complete", () => {
  it("same turn: edit deletes first 3 lines, bash edits last 3 → full +3 -6", async () => {
    // previous turn left a 6-line file
    const t1 = nextTurn();
    await toolWrite(P("six.txt"), "l1\nl2\nl3\nl4\nl5\nl6\n");
    await endTurn(t1);
    assert.equal(change(P("six.txt")).insertions, 6);

    // turn 2: edit deletes lines 1-3 (tool), then bash edits lines 4-6
    const t2 = nextTurn();
    await toolEdit(
      P("six.txt"),
      "--- a/six.txt\n+++ b/six.txt\n@@ -1,6 +1,3 @@\n-l1\n-l2\n-l3\n l4\n l5\n l6\n",
      "l4\nl5\nl6\n",
    );
    advanceClock(); // bash write must have a distinct mtime from the edit
    await writeAt(P("six.txt"), "l4-mod\nl5-mod\nl6-mod\n"); // bash edits the remaining 3
    await endTurn(t2);

    const c = change(P("six.txt"));
    assert.equal(c.insertions, 3, "the three edited lines");
    assert.equal(c.deletions, 6, "ALL six original lines removed — deletions must not vanish");
    assert.match(c.bashDiff ?? "", /-l1/, "deleted first block present");
    assert.match(c.bashDiff ?? "", /-l4/, "replaced line removed");
    assert.match(c.bashDiff ?? "", /\+l4-mod/, "replacement added");
    assert.doesNotMatch(c.bashDiff ?? "", /\+l1/, "nothing re-added from the deleted block");
  });

  it("across turns: edit deletes 3 in run N, bash edits 3 in run N+1 → incremental +3 -3", async () => {
    const t1 = nextTurn();
    await toolWrite(P("six2.txt"), "l1\nl2\nl3\nl4\nl5\nl6\n");
    await endTurn(t1);

    // run N: edit deletes lines 1-3 — summary shows the edit patch (-3)
    const tN = nextTurn();
    await toolEdit(
      P("six2.txt"),
      "--- a/six2.txt\n+++ b/six2.txt\n@@ -1,6 +1,3 @@\n-l1\n-l2\n-l3\n l4\n l5\n l6\n",
      "l4\nl5\nl6\n",
    );
    await endTurn(tN);
    const afterEdit = change(P("six2.txt"));
    assert.equal(afterEdit.deletions, 3, "edit patch: 3 deletions");

    // run N+1: bash edits the remaining 3 — incremental vs end of run N
    const tN1 = nextTurn();
    await writeAt(P("six2.txt"), "l4-mod\nl5-mod\nl6-mod\n");
    await endTurn(tN1);
    const c = change(P("six2.txt"));
    assert.equal(c.insertions, 3);
    assert.equal(c.deletions, 3, "only the 3 replaced lines — deletions of run N not re-shown");
    assert.doesNotMatch(c.bashDiff ?? "", /-l1/, "run N deletions are not repeated");
    assert.match(c.bashDiff ?? "", /-l4/, "run N+1 replacement shown");
    assert.match(c.bashDiff ?? "", /\+l4-mod/);
  });
});

describe("stats matrix: every tool-transition path counts diff lines exactly", () => {
  // Baseline file exists from conversation start with "a\nb\nc\n".
  function seedFile(name: string): void {
    snapshot.set(P(name), "a\nb\nc\n");
  }

  it("write → edit (same turn): edit stats replace write's", async () => {
    seedFile("t1.txt");
    nextTurn();
    await toolWrite(P("t1.txt"), "a\nb\nc\n");
    const t2 = nextTurn();
    await toolEdit(P("t1.txt"), "--- a/t1.txt\n+++ b/t1.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+b2\n c\n", "a\nb2\nc\n");
    await endTurn(t2);
    const c = change(P("t1.txt"));
    assert.equal(c.kind, "edit");
    assert.equal(c.insertions, 1, "edit adds b2");
    assert.equal(c.deletions, 1, "edit removes b");
    assert.equal(c.bashDiff, undefined, "no bash → no bashDiff");
  });

  it("bash → edit (same turn): scan recomputes the FULL stats", async () => {
    seedFile("t2.txt");
    const t1 = nextTurn();
    await writeAt(P("t2.txt"), "a\nb\nc\n");
    await endTurn(t1);
    // turn 2: bash appends a line, then edit modifies it
    const t2 = nextTurn();
    await writeAt(P("t2.txt"), "a\nb\nc\nd\n");
    advanceClock();
    await toolEdit(P("t2.txt"), "--- a/t2.txt\n+++ b/t2.txt\n@@ -4,1 +4,1 @@\n-d\n+d2\n", "a\nb\nc\nd2\n");
    await endTurn(t2);
    const c = change(P("t2.txt"));
    // The edit is the LAST operation in the turn: its patch is the diff
    // (the bash append d is visible as patch context). Stats = edit delta.
    assert.equal(c.insertions, 1, "edit adds d2");
    assert.equal(c.deletions, 1, "edit removes d");
    assert.equal(c.bashDiff, undefined, "no stale bash diff");
    assert.match(c.patch ?? "", /-d\n\+d2/, "edit patch shows the replacement");
  });

  it("bash → edit (across turns): turn 2 shows only the edit delta", async () => {
    seedFile("t3.txt");
    const t1 = nextTurn();
    await writeAt(P("t3.txt"), "a\nb\nc\nd\n"); // bash appends d
    await endTurn(t1);
    const afterT1 = change(P("t3.txt"));
    assert.equal(afterT1.insertions, 1, "turn 1: +d");

    const t2 = nextTurn();
    await toolEdit(P("t3.txt"), "--- a/t3.txt\n+++ b/t3.txt\n@@ -3,2 +3,2 @@\n c\n-d\n+d2\n", "a\nb\nc\nd2\n");
    await endTurn(t2);
    const c = change(P("t3.txt"));
    assert.equal(c.kind, "edit", "kind transitions to edit");
    assert.equal(c.insertions, 1, "turn 2 delta: +d2 only");
    assert.equal(c.deletions, 1, "turn 2 delta: -d only");
    assert.equal(c.bashDiff, undefined, "stale bash diff cleared by the edit");
  });

  it("edit → bash (same turn): full diff includes both operations", async () => {
    seedFile("t4.txt");
    const t1 = nextTurn();
    await writeAt(P("t4.txt"), "a\nb\nc\n");
    await endTurn(t1);
    const t2 = nextTurn();
    await toolEdit(P("t4.txt"), "--- a/t4.txt\n+++ b/t4.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+b2\n c\n", "a\nb2\nc\n");
    advanceClock();
    await writeAt(P("t4.txt"), "a\nb2\nc\nappended\n"); // bash appends
    await endTurn(t2);
    const c = change(P("t4.txt"));
    assert.equal(c.insertions, 2, "edit +b2 and bash +appended");
    assert.equal(c.deletions, 1, "edit -b");
    assert.match(c.bashDiff ?? "", /\+appended/);
    assert.match(c.bashDiff ?? "", /-b\n\+b2|-b\s/, "edit modification inside the bash diff");
  });

  it("bash → write (same turn): write stats win, no stale diff", async () => {
    seedFile("t5.txt");
    const t1 = nextTurn();
    await writeAt(P("t5.txt"), "a\nb\nc\nd\n"); // bash appends
    await endTurn(t1);
    const t2 = nextTurn();
    await toolWrite(P("t5.txt"), "brand new\n");
    await endTurn(t2);
    const c = change(P("t5.txt"));
    assert.equal(c.kind, "write");
    assert.equal(c.insertions, 1, "write content lines");
    assert.equal(c.bashDiff, undefined, "write clears any bash diff");
    assert.equal(c.shellTouched, undefined, "no bash after the write");
  });

  it("write → bash → edit (three ops, one turn): full stats preserved", async () => {
    seedFile("t6.txt");
    const t1 = nextTurn();
    await toolWrite(P("t6.txt"), "x\ny\n");
    advanceClock();
    await writeAt(P("t6.txt"), "x\ny\nz\n"); // bash appends z
    advanceClock();
    await toolEdit(P("t6.txt"), "--- a/t6.txt\n+++ b/t6.txt\n@@ -3,1 +3,1 @@\n-z\n+z2\n", "x\ny\nz2\n");
    await endTurn(t1);
    const c = change(P("t6.txt"));
    // The edit is the last op: its patch is the diff; the write and the bash
    // append appear as patch context (content is fully visible).
    assert.equal(c.insertions, 1, "edit adds z2");
    assert.equal(c.deletions, 1, "edit removes z");
    assert.equal(c.bashDiff, undefined);
    assert.match(c.patch ?? "", /-z\n\+z2/);
  });

  it("delete via bash after edit does not resurrect stale stats", async () => {
    seedFile("t7.txt");
    const t1 = nextTurn();
    await writeAt(P("t7.txt"), "a\nb\nc\n");
    await endTurn(t1);
    const t2 = nextTurn();
    await toolEdit(P("t7.txt"), "--- a/t7.txt\n+++ b/t7.txt\n@@ -1,3 +1,3 @@\n a\n-b\n+b2\n c\n", "a\nb2\nc\n");
    advanceClock();
    await rm(P("t7.txt")); // bash deletes
    await endTurn(t2);
    const c = change(P("t7.txt"));
    assert.equal(c.shellTouched, true);
    assert.equal(c.insertions, 0, "nothing added");
    assert.equal(c.deletions, 3, "all three original lines removed (known content baseline)");
    assert.match(c.bashDiff ?? "", /-a/, "deletion diff uses the known baseline");
  });
});

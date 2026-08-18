/**
 * Regression coverage for Pi's two lifecycle layers:
 * - agent_end: one low-level run (may retry / compact / continue)
 * - agent_settled: the whole user-visible run is finally idle
 *
 * pi-file-diff must publish exactly one receipt at the latter boundary.
 */

import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fileDiffExtension from "../index.ts";
import type { SummaryPayload } from "../render.ts";

type Handler = (event: unknown, ctx: unknown) => unknown;

class FakePi {
  readonly entries: Array<{ type: string; data: unknown }> = [];
  private readonly handlers = new Map<string, Handler[]>();

  on(event: string, handler: Handler): void {
    const registered = this.handlers.get(event) ?? [];
    registered.push(handler);
    this.handlers.set(event, registered);
  }

  registerEntryRenderer(_type: string, _renderer: unknown): void {}

  registerCommand(_name: string, _command: unknown): void {}

  registerShortcut(_key: string, _shortcut: unknown): void {}

  appendEntry(type: string, data?: unknown): void {
    this.entries.push({ type, data });
  }

  async emit(event: string, payload: unknown = {}, ctx: unknown = {}): Promise<void> {
    for (const handler of this.handlers.get(event) ?? []) {
      await handler(payload, ctx);
    }
  }

  summaries(): SummaryPayload[] {
    return this.entries
      .filter((entry) => entry.type === "pi-file-diff-summary")
      .map((entry) => entry.data as SummaryPayload);
  }
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-file-diff-lifecycle-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function settleInitialBaseline(): Promise<void> {
  // agent_start begins the async file-set baseline. Let that read complete
  // before creating test files, matching a real agent's first tool call.
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
}

async function recordWrite(api: FakePi, file: string, content: string): Promise<void> {
  await writeFile(file, content);
  await api.emit("tool_result", {
    toolName: "write",
    input: { path: file, content },
  });
}

function startExtension(): FakePi {
  const api = new FakePi();
  fileDiffExtension(api as unknown as ExtensionAPI);
  return api;
}

describe("settled-run summaries", () => {
  it("merges retry/follow-up low-level runs and ignores their agent_end events", async () => {
    const api = startExtension();
    await api.emit("session_start", {}, { cwd: dir });

    await api.emit("agent_start");
    await settleInitialBaseline();
    await recordWrite(api, join(dir, "first.txt"), "first\n");

    // A retry or queued follow-up produces one or more low-level ends. These
    // must not create intermediate, overlapping summary entries.
    await api.emit("agent_end", { willRetry: true });
    await api.emit("agent_end", { willRetry: false });
    assert.equal(api.summaries().length, 0);

    await api.emit("agent_start");
    await recordWrite(api, join(dir, "second.txt"), "second\n");
    await api.emit("agent_end", { willRetry: false });
    assert.equal(api.summaries().length, 0);

    await api.emit("agent_settled");
    const [summary] = api.summaries();
    assert.equal(api.summaries().length, 1);
    assert.equal(summary?.totalFiles, 2);
    assert.deepEqual(summary?.files.map((file) => file.file).sort(), ["first.txt", "second.txt"]);
  });

  it("keeps an earlier low-level run's changes when the final continuation is a no-op", async () => {
    const api = startExtension();
    await api.emit("session_start", {}, { cwd: dir });

    await api.emit("agent_start");
    await settleInitialBaseline();
    await recordWrite(api, join(dir, "kept.txt"), "kept\n");
    await api.emit("agent_end", { willRetry: false });

    // A queued continuation that merely responds must not reset the mutation
    // baseline and make the preceding real file change disappear.
    await api.emit("agent_start");
    await api.emit("agent_end", { willRetry: false });
    await api.emit("agent_settled");

    const [summary] = api.summaries();
    assert.equal(api.summaries().length, 1);
    assert.equal(summary?.totalFiles, 1);
    assert.equal(summary?.files[0]?.file, "kept.txt");
  });

  it("is idempotent when agent_settled is delivered twice", async () => {
    const api = startExtension();
    await api.emit("session_start", {}, { cwd: dir });

    await api.emit("agent_start");
    await settleInitialBaseline();
    await recordWrite(api, join(dir, "once.txt"), "once\n");
    await api.emit("agent_settled");
    await api.emit("agent_settled");

    assert.equal(api.summaries().length, 1);
    assert.equal(api.summaries()[0]?.totalFiles, 1);
  });

  it("does not emit a receipt for a settled run without file changes", async () => {
    const api = startExtension();
    await api.emit("session_start", {}, { cwd: dir });

    await api.emit("agent_start");
    await settleInitialBaseline();
    await api.emit("agent_end", { willRetry: false });
    await api.emit("agent_settled");

    assert.equal(api.summaries().length, 0);
  });
});

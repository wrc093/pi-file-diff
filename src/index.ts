/**
 * pi-file-diff — pi extension entry point.
 *
 * Semantics: one conversation (session) accumulates every file mutation made
 * by the agent — edit patches, write contents, plus shell-detected changes —
 * from the initial state onward. A summary is sent automatically when a
 * user-visible agent task fully settles, and on demand via /file-diff.
 */

import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isBashToolResult, isEditToolResult, isWriteToolResult } from "@earendil-works/pi-coding-agent";
import { ChangeTracker } from "./tracker.ts";
import { buildPayload, type SummaryPayload } from "./render.ts";
import { createSummaryEntryRenderer } from "./renderer.ts";
import { FileDiffPanel, type PanelFile } from "./diffviewer.ts";
import { detectTrackedFiles } from "./git.ts";
import { collectFileSet, takeContentSnapshot } from "./snapshot.ts";
import { messagesFor, resolveConfig, type Messages } from "./i18n.ts";
import { completePath, resolveUserPath } from "./path-complete.ts";

const CUSTOM_TYPE = "pi-file-diff-summary";

export default function (pi: ExtensionAPI): void {
  const agentDir = getAgentDir();
  const config = resolveConfig(agentDir);
  const msgs: Messages = messagesFor(config.lang);
  const extraIgnore = new Set(config.ignore);
  /** Effective bash mode for the current settled run: "on" or "off". */
  let bashMode: "on" | "off" = "on";
  /** True when auto mode degraded due to the file-count threshold. */
  let degraded = false;
  /** Workspace file count of the current settled run (from the baseline walk). */
  let workspaceFileCount = 0;
  let tracker: ChangeTracker | null = null;
  let cwd = "";
  let epoch = 0;
  /**
   * A Pi "settled run" may contain several low-level agent runs: retries,
   * compaction retries, and queued follow-ups each emit agent_start/agent_end.
   * Keep one baseline until agent_settled so their file changes become one
   * receipt instead of several overlapping summaries.
   */
  let settledRunActive = false;
  /** In-flight/finished auto-summary for the active settled run. */
  let settledRunSummary: Promise<void> | null = null;
  let runStartTime = 0;
  let bashRan = false;
  /** Tracker mutation count when the current settled run started. */
  let runStartMutations = 0;
  /** Content right after write/edit tools finished (abs path → content). */
  const toolContents = new Map<string, string>();
  /** Live set of excluded absolute paths (dirs or files). */
  const excludePaths = new Set<string>();
  let snapshot: { contents: Map<string, string>; seen: Set<string> } | null = null;
  let snapshotPromise: Promise<{ contents: Map<string, string>; seen: Set<string> }> | null = null;
  /** Files that existed when the current settled run started (per-task baseline). */
  let runSeen: Set<string> | null = null;
  let runSeenPromise: Promise<Set<string>> | null = null;

  function reset(newCwd: string): void {
    epoch++;
    cwd = newCwd;
    excludePaths.clear();
    for (const p of config.exclude) excludePaths.add(resolveUserPath(p, cwd));
    tracker = new ChangeTracker(cwd, extraIgnore, excludePaths);
    settledRunActive = false;
    settledRunSummary = null;
    runStartTime = 0;
    bashRan = false;
    snapshot = null;
    snapshotPromise = null;
  }

  /** Snapshot text contents once per conversation (lazy, idempotent). */
  function ensureSnapshot(): Promise<{ contents: Map<string, string>; seen: Set<string> }> {
    if (snapshot) return Promise.resolve(snapshot);
    if (!snapshotPromise) {
      snapshotPromise = takeContentSnapshot(cwd, extraIgnore).then((s) => {
        snapshot = s;
        return s;
      });
    }
    return snapshotPromise;
  }

  /**
   * Per-settled-run file-set baseline: which files existed when the task started.
   * Re-taken for every user-visible task (status must reflect the task's
   * initial state, e.g. appending to a file created in an earlier run is a
   * content modification, not a new file).
   */
  function ensureRunSeen(): Promise<Set<string>> {
    if (runSeen) return Promise.resolve(runSeen);
    if (!runSeenPromise) {
      runSeenPromise = collectFileSet(cwd, extraIgnore).then((s) => {
        runSeen = s;
        return s;
      });
    }
    return runSeenPromise;
  }

  pi.registerEntryRenderer(CUSTOM_TYPE, createSummaryEntryRenderer(msgs));

  pi.registerEntryRenderer("pi-file-diff-notice", (entry, _options, theme) => {
    const text = (entry.data as { text?: string } | undefined)?.text ?? "";
    return new Text(theme.fg("warning", text), 0, 0);
  });

  pi.on("session_start", (_event, ctx) => {
    reset(ctx.cwd);
  });

  pi.on("session_tree", (_event, ctx) => {
    reset(ctx.cwd);
  });

  pi.on("session_shutdown", () => {
    epoch++;
    tracker = null;
  });

  pi.on("tool_result", (event) => {
    if (!tracker) return;
    if (isWriteToolResult(event)) {
      // Remember the content the tool wrote, so the end-of-turn bash scan
      // can tell the tool's own write apart from a later shell modification.
      const abs = tracker.normalizePath(event.input.path as string);
      toolContents.set(abs, event.input.content as string);
    }
    if (isEditToolResult(event)) {
      tracker.recordEdit(event.input.path as string, event.details?.patch);
      try {
        const abs = tracker.normalizePath(event.input.path as string);
        const st = statSync(abs);
        if (st.size <= 512 * 1024) {
          toolContents.set(abs, readFileSync(abs, "utf-8"));
        }
      } catch {
        // file not readable — nothing to compare against
      }
    } else if (isWriteToolResult(event)) {
      tracker.recordWrite(event.input.path as string, event.input.content as string);
    } else if (isBashToolResult(event)) {
      bashRan = true;
    }
  });

  pi.on("agent_start", () => {
    // agent_start is deliberately low-level. A retry, a compaction retry, or
    // a queued follow-up starts another low-level run before the user-visible
    // task has settled. Do not reset the per-task baseline in that case.
    if (settledRunActive) return;
    settledRunActive = true;
    settledRunSummary = null;
    runStartTime = Date.now();
    bashRan = false;
    runStartMutations = tracker?.mutations ?? 0;
    // Fresh per-settled-run baseline (also yields the workspace file count).
    runSeen = null;
    runSeenPromise = null;
    void ensureRunSeen().then((seen) => {
      workspaceFileCount = seen.size;
      if (config.bashTracking === "off") {
        bashMode = "off";
        degraded = false;
        return;
      }
      if (config.bashTracking === "on" || seen.size <= config.bashThreshold) {
        bashMode = "on";
        degraded = false;
        // Snapshot must start BEFORE any tool runs, or the baseline would
        // already contain the shell modifications (making diffs empty).
        void ensureSnapshot();
      } else {
        // Auto-degraded: workspace too large for snapshot diffing.
        bashMode = "off";
        degraded = true;
      }
    });
  });

  async function sendSummary(onlyIfChangedThisRun = true): Promise<void> {
    if (!tracker) return;
    // Capture a local reference: the session may shut down while we await
    // the bash scan, which nulls the module-level tracker.
    const t = tracker;
    let snap: { contents: Map<string, string>; seen: Set<string> } | null = null;
    if (bashRan && runStartTime > 0 && bashMode === "on") {
      try {
        snap = await ensureSnapshot();
        await t.collectBashChanges(runStartTime, snap.contents, toolContents);
      } catch {
        // Best effort — never break the session for a scan failure
      }
    }
    try {
      // End-of-run baseline refresh: the next run's incremental diffs are
      // computed against the state at the END of this run, regardless of
      // which tools touched files (see tracker.refreshKnownContents).
      await t.refreshKnownContents();
    } catch {
      // best effort
    }
    // Auto-degraded: tell the user once per run that bash diffs are off.
    if (degraded && bashRan) {
      try {
        pi.appendEntry("pi-file-diff-notice", {
          text: msgs.degradeNotice(workspaceFileCount, config.bashThreshold),
        });
      } catch {
        // session may have closed
      }
    }
    // Automatic summaries only report a settled run that changed something.
    // The manual /file-diff command deliberately bypasses this gate so it can
    // re-open the full conversation change list after a run has settled.
    if (onlyIfChangedThisRun && t.mutations <= runStartMutations) return;
    await t.resolveFileStatuses(await ensureRunSeen());
    const tracked = await detectTrackedFiles(cwd);
    const payload: SummaryPayload | null = buildPayload(t.all, (abs) => t.displayPath(abs), tracked, excludePaths);
    if (!payload) return;
    try {
      // Entries are display-only and stay out of LLM context: appending the
      // summary must not wake the agent or queue extra runs (sendMessage with
      // steer delivery was verified to trigger repeated agent_start cycles).
      pi.appendEntry(CUSTOM_TYPE, payload);
    } catch {
      // Session may have already closed — ignore append errors
    }
  }

  async function sendSettledSummary(): Promise<void> {
    if (!settledRunActive) return;
    // Pi emits agent_settled once per completed task, but sharing the promise
    // also makes this idempotent if a host/runtime accidentally delivers it
    // more than once while the filesystem scan is still in flight.
    if (!settledRunSummary) settledRunSummary = sendSummary(true);
    await settledRunSummary;
  }

  pi.on("agent_settled", async () => {
    if (!settledRunActive) return;
    try {
      await sendSettledSummary();
    } finally {
      // The next agent_start begins a new user-visible run and gets a fresh
      // mutation baseline. Keep runStartMutations intact for /file-diff.
      settledRunActive = false;
    }
  });

  pi.registerCommand("file-diff", {
    description: msgs.commandDesc,
    handler: async () => {
      await sendSummary(false);
    },
  });

  /** Persist a partial config into <agentDir>/file-diff.json. */
  function writeConfigFile(patch: Record<string, unknown>): void {
    const path = join(agentDir, "file-diff.json");
    let current: Record<string, unknown> = {};
    try {
      current = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    } catch {
      // no config file yet
    }
    writeFileSync(path, JSON.stringify({ ...current, ...patch }, null, 2) + "\n");
  }

  pi.registerCommand("file-diff-mode", {
    description: msgs.modeCommandDesc,
    getArgumentCompletions: (prefix) => {
      const options = ["auto", "on", "off", "status"];
      const filtered = options.filter((o) => o.startsWith(prefix.trim()));
      return filtered.length > 0 ? filtered.map((o) => ({ value: o, label: o })) : null;
    },
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (arg === "" || arg === "status") {
        ctx.ui.notify(msgs.modeStatus(config.bashTracking, config.bashThreshold, workspaceFileCount), "info");
        return;
      }
      if (arg === "auto" || arg === "on" || arg === "off") {
        // Apply immediately to the running session AND persist for restarts.
        config.bashTracking = arg;
        try {
          writeConfigFile({ bashTracking: arg });
          ctx.ui.notify(msgs.modeSetResult(arg), "info");
        } catch (e) {
          ctx.ui.notify(`Failed to save config: ${e instanceof Error ? e.message : String(e)}`, "error");
        }
        return;
      }
      ctx.ui.notify(msgs.modeStatus(config.bashTracking, config.bashThreshold, workspaceFileCount), "info");
    },
  });

  pi.registerCommand("file-diff-exclude", {
    description: msgs.excludeCommandDesc,
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trim();
      if (trimmed.startsWith("remove ")) {
        const partial = trimmed.slice(7);
        const items = [...excludePaths]
          .filter((p) => p.startsWith(partial))
          .map((p) => ({ value: `remove ${p}`, label: p }));
        return items.length > 0 ? items : null;
      }
      if (trimmed.startsWith("clear")) return null;
      return completePath(trimmed, cwd);
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (trimmed === "") {
        const list = [...excludePaths];
        ctx.ui.notify(list.length === 0 ? msgs.excludeNone : list.join("\n"), "info");
        return;
      }
      if (trimmed === "clear") {
        excludePaths.clear();
        config.exclude = [];
        writeConfigFile({ exclude: [] });
        ctx.ui.notify(msgs.excludeRemoved("*"), "info");
        return;
      }
      if (trimmed.startsWith("remove ")) {
        const target = resolveUserPath(trimmed.slice(7).trim(), cwd);
        if (excludePaths.delete(target)) {
          config.exclude = [...excludePaths];
          writeConfigFile({ exclude: [...excludePaths] });
          ctx.ui.notify(msgs.excludeRemoved(target), "info");
        } else {
          ctx.ui.notify(msgs.excludeUsage, "warning");
        }
        return;
      }
      // add — accept a dir or a single file path
      const abs = resolveUserPath(trimmed, cwd);
      if (abs === cwd) {
        ctx.ui.notify(msgs.excludeUsage, "warning");
        return;
      }
      excludePaths.add(abs);
      config.exclude = [...excludePaths];
      try {
        writeConfigFile({ exclude: [...excludePaths] });
        ctx.ui.notify(msgs.excludeAdded(trimmed), "info");
      } catch (e) {
        ctx.ui.notify(`Failed to save config: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerShortcut("ctrl+q", {
    description: msgs.shortcutDesc,
    handler: async (ctx) => {
      const t = tracker;
      if (!t || t.size === 0) {
        ctx.ui.notify(msgs.noChanges, "info");
        return;
      }
      await t.resolveFileStatuses(await ensureRunSeen());
      const tracked = await detectTrackedFiles(cwd);
      const files: PanelFile[] = t.all
        .filter((change) => !t.isExcluded(change.path))
        .map((change) => ({
          path: t.displayPath(change.path),
          change,
          tracked: tracked?.has(t.displayPath(change.path)),
        }));
      await ctx.ui.custom<boolean>(
        (tui, theme, keybindings, done) => {
          const panel = new FileDiffPanel(
            files,
            theme,
            keybindings,
            () => tui.requestRender(),
            () => done(true),
            undefined,
            msgs,
            () => tui.terminal.rows,
          );
          return panel;
        },
        {
          overlay: true,
          // FileDiffPanel pads itself to the viewport height, so the overlay
          // is an opaque fullscreen modal rather than a short transparent
          // panel over the summary entry and editor.
          overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" },
        },
      );
    },
  });
}

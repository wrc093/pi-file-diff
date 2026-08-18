/**
 * pi-file-diff — Internationalization.
 *
 * Pure data module (no pi imports) so it stays unit-testable. Language
 * resolution: PI_FILE_DIFF_LANG env var, then <agentDir>/file-diff.json
 * {"lang": "..."}, default "en".
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BASH_THRESHOLD } from "./tracker.ts";

export type Lang = "en" | "zh";

/**
 * Whether shell-driven file changes are tracked.
 * - "auto": track unless the workspace exceeds the file-count threshold
 * - "on": always track (force, ignores the threshold)
 * - "off": never track (native write/edit tools only)
 */
export type BashTracking = "auto" | "on" | "off";

export interface FileDiffConfig {
  lang: Lang;
  bashTracking: BashTracking;
  /** File-count threshold for auto mode (default: DEFAULT_BASH_THRESHOLD). */
  bashThreshold: number;
  /** Extra directory names to ignore (case-insensitive). */
  ignore: string[];
  /** Paths (dirs or files, relative to cwd or absolute) excluded from diff stats. */
  exclude: string[];
}

export interface Messages {
  /** "1 file changed" / "3 files changed" */
  filesChanged: (n: number) => string;
  /** Marker appended to shell-only changes (kept as the shell term). */
  shellMarker: string;
  /** Marker for files also modified by shell after edit/write. */
  shellTouchedMarker: string;
  /** Marker for files added at the file level. */
  newFileMarker: string;
  /** Marker for files deleted at the file level. */
  deletedFileMarker: string;
  /** Footer hint under the summary entry. */
  summaryHint: string;
  /** Footer of the panel list view. */
  listFooter: string;
  /** Footer of the panel diff view. */
  diffFooter: string;
  /** Placeholder when a shell change has no computable diff. */
  noDiffContent: string;
  /** Placeholder when a change has no diff at all. */
  noDiff: string;
  /** Note shown above the full content of an added file. */
  newFileFull: string;
  /** Note shown above the removed content of a deleted file. */
  deletedFileFull: string;
  /** Warning for files with an incomplete diff. */
  shellIncomplete: string;
  /** Notification when ctrl+q is pressed with no changes. */
  noChanges: string;
  /** Description of the /file-diff command. */
  commandDesc: string;
  /** Description of the ctrl+q shortcut. */
  shortcutDesc: string;
  /** Degradation notice when the workspace exceeds the threshold. */
  degradeNotice: (count: number, threshold: number) => string;
  /** Description of the /file-diff-mode command. */
  modeCommandDesc: string;
  /** Status line for /file-diff-mode. */
  modeStatus: (mode: string, threshold: number, files: number) => string;
  /** Confirmation after setting the mode. */
  modeSetResult: (mode: string) => string;
  /** Hint shown when the summary overflows (>10 files). */
  excludeHint: string;
  /** Description of the /file-diff-exclude command. */
  excludeCommandDesc: string;
  /** Confirmation after adding an exclusion. */
  excludeAdded: (path: string) => string;
  /** Confirmation after removing an exclusion. */
  excludeRemoved: (path: string) => string;
  /** Empty-state text for the exclusion list. */
  excludeNone: string;
  /** Usage line for /file-diff-exclude. */
  excludeUsage: string;
}

export const enMessages: Messages = {
  filesChanged: (n) => `${n} file${n !== 1 ? "s" : ""} changed`,
  shellMarker: " (shell)",
  shellTouchedMarker: " (shell-modified)",
  newFileMarker: " (new file)",
  deletedFileMarker: " (deleted)",
  summaryHint: "[ctrl+q] view per-file diff · /file-diff: full session changes",
  listFooter: "\u2191\u2193 or wheel: switch \u00b7 Enter: view diff \u00b7 Esc: close",
  diffFooter: "\u2191\u2193 scroll \u00b7 \u2190/Esc: back \u00b7 Enter: close",
  noDiffContent: "(shell change, no diff \u2014 file too large/binary or snapshot missing)",
  noDiff: "(no diff content)",
  newFileFull: "(new file \u2014 full content below)",
  deletedFileFull: "(file deleted \u2014 original content below)",
  shellIncomplete: "\u26a0 file was also modified by shell after edit/write; diff may be incomplete",
  noChanges: "No file changes yet",
  commandDesc: "Show files changed this conversation",
  shortcutDesc: "Open interactive file/diff panel for this conversation",
  degradeNotice: (count, threshold) =>
    `⚠ Workspace has ${count} files — over the bash-diff threshold (${threshold}). Bash change tracking is disabled; only write/edit diffs are shown. Run /file-diff-mode on to force-enable (slower scans), or /file-diff-mode for details.`,
  modeCommandDesc: "View or change bash change tracking (auto/on/off)",
  modeStatus: (mode, threshold, files) =>
    `pi-file-diff: bash tracking = ${mode} (threshold ${threshold}, workspace ${files} files). Usage: /file-diff-mode auto|on|off`,
  modeSetResult: (mode) => `Bash change tracking set to "${mode}" — applies to the next run.`,
  excludeHint: ">10 files changed — run /file-diff-exclude <path> to hide noisy paths (Tab completes)",
  excludeCommandDesc: "Exclude paths from diff stats (add / remove / list)",
  excludeAdded: (path) => `Excluded: ${path} — applies to the next run.`,
  excludeRemoved: (path) => `No longer excluded: ${path}`,
  excludeNone: "No paths excluded. Usage: /file-diff-exclude <path> (Tab completes) · remove <path> · clear",
  excludeUsage: "Usage: /file-diff-exclude <path> (Tab completes) · remove <path> · clear",
};

export const zhMessages: Messages = {
  filesChanged: (n) => `${n} 个文件改动`,
  shellMarker: " (shell)",
  shellTouchedMarker: " (shell 还有改动)",
  newFileMarker: " (新文件)",
  deletedFileMarker: " (已删除)",
  summaryHint: "[ctrl+q] 查看单个文件 diff · /file-diff 查看会话全量改动",
  listFooter: "\u2191\u2193/滚轮 切换 · Enter 查看 diff · Esc 关闭",
  diffFooter: "\u2191\u2193 滚动 · \u2190/Esc 返回列表 · Enter 关闭",
  noDiffContent: "(shell 修改，无 diff 内容 — 文件过大/二进制或快照缺失)",
  noDiff: "(无 diff 内容)",
  newFileFull: "(新文件 — 以下为完整内容)",
  deletedFileFull: "(文件已删除 — 以下为原内容)",
  shellIncomplete: "\u26a0 该文件在 edit/write 之后还被 shell 修改过，diff 可能不完整",
  noChanges: "暂无文件改动",
  commandDesc: "展示本次对话改动的文件列表",
  shortcutDesc: "打开本次对话的交互式文件/diff 面板",
  degradeNotice: (count, threshold) =>
    `⚠ 工作区包含 ${count} 个文件，超过 bash diff 阈值（${threshold}），bash 改动跟踪已自动关闭，仅保留 write/edit 的 diff。输入 /file-diff-mode on 可强制开启（扫描会变慢），或 /file-diff-mode 查看说明。`,
  modeCommandDesc: "查看/修改 bash 改动跟踪模式（auto/on/off）",
  modeStatus: (mode, threshold, files) =>
    `pi-file-diff: bash 跟踪 = ${mode}（阈值 ${threshold}，工作区 ${files} 个文件）。用法：/file-diff-mode auto|on|off`,
  modeSetResult: (mode) => `bash 改动跟踪已设为「${mode}」，下一次对话生效。`,
  excludeHint: ">10 个文件改动 — 运行 /file-diff-exclude <路径> 屏蔽不关心的路径（Tab 补全）",
  excludeCommandDesc: "从 diff 统计中排除路径（添加 / 移除 / 查看）",
  excludeAdded: (path) => `已排除：${path}，下一次对话生效。`,
  excludeRemoved: (path) => `已取消排除：${path}`,
  excludeNone: "当前没有排除路径。用法：/file-diff-exclude <路径>（Tab 补全）· remove <路径> · clear",
  excludeUsage: "用法：/file-diff-exclude <路径>（Tab 补全）· remove <路径> · clear",
};

export function isLang(value: unknown): value is Lang {
  return value === "en" || value === "zh";
}

/**
 * Resolve the display language.
 * Precedence: PI_FILE_DIFF_LANG env var > <agentDir>/file-diff.json "lang"
 * field > "en". agentDir is injected so this stays pure and testable.
 */
export function resolveLang(agentDir: string | undefined): Lang {
  return resolveConfig(agentDir).lang;
}

/**
 * Resolve the extension config.
 * Env vars PI_FILE_DIFF_LANG / PI_FILE_DIFF_BASH_TRACKING win over
 * <agentDir>/file-diff.json fields; defaults en / auto.
 */
export function resolveConfig(agentDir: string | undefined): FileDiffConfig {
  const envLang = process.env.PI_FILE_DIFF_LANG?.trim().toLowerCase();
  const envBash = process.env.PI_FILE_DIFF_BASH_TRACKING?.trim().toLowerCase();
  let fileLang: unknown;
  let fileBash: unknown;
  let fileThreshold: unknown;
  let fileIgnore: unknown;
  let fileExclude: unknown;
  if (agentDir) {
    try {
      const text = readFileSync(join(agentDir, "file-diff.json"), "utf-8");
      const parsed = JSON.parse(text) as {
        lang?: unknown;
        bashTracking?: unknown;
        bashThreshold?: unknown;
        ignore?: unknown;
        exclude?: unknown;
      };
      fileLang = parsed.lang;
      fileBash = parsed.bashTracking;
      fileThreshold = parsed.bashThreshold;
      fileIgnore = parsed.ignore;
      fileExclude = parsed.exclude;
    } catch {
      // missing/unreadable config — use defaults
    }
  }

  const lang: Lang =
    isLang(envLang) ? envLang : isLang(fileLang) ? fileLang : "en";
  const bashTracking: BashTracking =
    envBash === "auto" || envBash === "on" || envBash === "off"
      ? envBash
      : fileBash === "auto" || fileBash === "on" || fileBash === "off"
        ? fileBash
        : "auto";
  const bashThreshold =
    typeof fileThreshold === "number" && fileThreshold > 0
      ? Math.floor(fileThreshold)
      : DEFAULT_BASH_THRESHOLD;
  const ignore = Array.isArray(fileIgnore)
    ? fileIgnore.filter((i): i is string => typeof i === "string" && i.length > 0).map((i) => i.toLowerCase())
    : [];
  const exclude = Array.isArray(fileExclude)
    ? fileExclude.filter((p): p is string => typeof p === "string" && p.length > 0)
    : [];
  return { lang, bashTracking, bashThreshold, ignore, exclude };
}

export function messagesFor(lang: Lang): Messages {
  return lang === "zh" ? zhMessages : enMessages;
}

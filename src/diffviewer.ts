/**
 * pi-file-diff — Interactive file/diff panel.
 *
 * Shown via ctrl+q as a fullscreen overlay. Two views:
 *  - list:   one line per changed file, selection highlighted; navigate with
 *            arrow keys / j k / page keys / mouse wheel
 *  - diff:   the selected file's full diff (+ green, - red, context dim);
 *            arrow keys scroll, Esc / left-arrow returns to the list
 *
 * Mouse wheel events are read directly from process.stdin (the TUI reads the
 * same stream; its alt-screen consumer handles scrolling of the transcript
 * underneath, which is hidden by the opaque overlay). SGR sequences look
 * like `\x1b[<64;x;yM` (wheel up) / `\x1b[<65;x;yM` (wheel down).
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager } from "@earendil-works/pi-tui";
import { enMessages, type Messages } from "./i18n.ts";
import { withGreenSuccess } from "./colors.ts";
import { MAX_DIFF_LINES, splitContentLines, type ColorFn } from "./render.ts";
import type { ChangeKind, TrackedChange } from "./tracker.ts";

export interface PanelFile {
  /** Display path */
  path: string;
  change: TrackedChange;
  /** Git tracking status (undefined when workspace has no git) */
  tracked?: boolean;
}

/**
 * Keep Git sections contiguous before pagination. The tracker preserves tool
 * execution order, which can interleave tracked and untracked paths (for
 * example, write a new file, edit an existing file, then write another).
 * Rendering that order directly makes the same section heading repeat within
 * a page. Preserve the original order within each section while placing all
 * tracked files before untracked files, matching the summary view.
 */
function groupFilesByGitStatus(files: readonly PanelFile[]): PanelFile[] {
  const tracked: PanelFile[] = [];
  const untracked: PanelFile[] = [];

  for (const file of files) {
    if (file.tracked === true) tracked.push(file);
    else untracked.push(file);
  }

  return tracked.length > 0 && untracked.length > 0 ? [...tracked, ...untracked] : [...files];
}

type View = "list" | "diff";

const REVERSE_ON = "\x1b[7m";
const REVERSE_OFF = "\x1b[27m";

/** Max wheel events handled per chunk before giving up (safety). */
const MAX_EVENTS_PER_CHUNK = 32;

/**
 * Extract wheel-up / wheel-down events from raw terminal input, tolerating
 * SGR sequences split across chunks. Returns a delta (-1 up, +1 down).
 */
export class MouseWheelParser {
  private pending = "";

  push(data: string): number {
    this.pending += data;
    let delta = 0;
    const re = /\x1b\[<(\d+);\d+;\d+([Mm])/g;
    let m: RegExpExecArray | null;
    let consumed = 0;
    let events = 0;

    while ((m = re.exec(this.pending)) && events < MAX_EVENTS_PER_CHUNK) {
      consumed = re.lastIndex;
      events++;
      const button = Number.parseInt(m[1]!, 10);
      const release = m[2] === "m";
      if (release) continue; // ignore release half of the wheel event
      if (button === 64) delta -= 1; // wheel up
      else if (button === 65) delta += 1; // wheel down
    }

    if (consumed > 0) {
      this.pending = this.pending.slice(consumed);
      // Trim any non-SGR prefix garbage
      const first = this.pending.indexOf("\x1b[<");
      if (first > 0) this.pending = this.pending.slice(first);
    }
    if (this.pending.length > 64) this.pending = "";
    return delta;
  }
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** One diff line with resolved line numbers. */
export interface NumberedDiffLine {
  text: string;
  /** Line number in the old file (- lines, context) */
  oldLine?: number;
  /** Line number in the new file (+ lines, context) */
  newLine?: number;
}

/**
 * Parse a unified patch into lines with line numbers, tracking hunk cursors:
 * context advances both, - advances old, + advances new. Headers (---/+++,
 * Index:/====) are dropped; @@ hunk headers are kept without numbers.
 */
export function parseNumberedLines(patch: string): NumberedDiffLine[] {
  const out: NumberedDiffLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;

  for (const line of patch.split("\n")) {
    if (line === "") continue; // trailing newline artifact, never real content
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      out.push({ text: line });
      continue;
    }
    if (
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("Index: ") ||
      line.startsWith("=")
    ) {
      continue; // headers
    }
    if (line.startsWith("\\")) {
      out.push({ text: line }); // "\ No newline" marker — no numbers
      continue;
    }
    if (line.startsWith("-")) {
      out.push({ text: line, oldLine });
      if (oldLine !== undefined) oldLine++;
      continue;
    }
    if (line.startsWith("+")) {
      out.push({ text: line, newLine });
      if (newLine !== undefined) newLine++;
      continue;
    }
    // context line
    out.push({ text: line, oldLine, newLine });
    if (oldLine !== undefined) oldLine++;
    if (newLine !== undefined) newLine++;
  }
  return out;
}

/**
 * Pure helper: build the colored diff view lines for a change.
 * Lines use a conventional diff gutter: line number, change marker, divider,
 * then source text. The marker lives outside the text column so `+` and `-`
 * cannot be confused with characters from the changed file. Non-adjacent
 * lines are separated by a ⋯ gap marker.
 */
export function buildDiffViewLines(
  change: TrackedChange,
  fg: (color: Parameters<NonNullable<Theme["fg"]>>[0], text: string) => string,
  msgs: Messages = enMessages,
): string[] {
  const lines: string[] = [];

  const renderPatch = (patch: string) => {
    const numbered = parseNumberedLines(patch);
    const nums = numbered.flatMap((l) => [l.oldLine, l.newLine]).filter((n): n is number => n !== undefined);
    const width = Math.max(1, ...nums.map((n) => String(n).length));
    const emptyGutter = " ".repeat(width) + "   │";
    let lastNum: number | undefined;

    for (const l of numbered) {
      const num = l.text.startsWith("-") ? l.oldLine : l.newLine;
      const color = l.text.startsWith("+") && !l.text.startsWith("+++") ? "success" : l.text.startsWith("-") && !l.text.startsWith("---") ? "error" : "dim";
      if (num !== undefined && lastNum !== undefined && num - lastNum > 1) {
        lines.push(fg("dim", `${emptyGutter} ⋯`));
      }
      if (num !== undefined) lastNum = num;
      const hasUnifiedPrefix = l.text.startsWith("+") || l.text.startsWith("-") || l.text.startsWith(" ");
      const marker = l.text.startsWith("+") ? "+" : l.text.startsWith("-") ? "-" : " ";
      const source = hasUnifiedPrefix ? l.text.slice(1) : l.text;
      const gutter = num !== undefined ? `${String(num).padStart(width)} ${marker} │` : emptyGutter;
      lines.push(fg(color, `${gutter} ${source}`));
    }
  };

  if (change.bashDiff) {
    // Shell modification — incremental diff vs the latest known content.
    // Takes priority: it reflects the newest state of the file.
    renderPatch(change.bashDiff);
  } else if (change.kind === "edit" && change.patch) {
    renderPatch(change.patch);
  } else if (change.kind === "write" && change.content !== undefined) {
    const { lines: contentLines } = splitContentLines(change.content, MAX_DIFF_LINES);
    const width = Math.max(1, String(contentLines.length).length);
    contentLines.forEach((cl, i) => {
      lines.push(fg("success", `${String(i + 1).padStart(width)} + │ ${cl}`));
    });
  } else if (change.kind === "bash") {
    lines.push(fg("dim", msgs.noDiffContent));
  } else {
    lines.push(fg("dim", msgs.noDiff));
  }

  return lines;
}

/** Minimal shape of the raw input stream we tap for mouse events. */
export interface MouseInputSource {
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  removeListener(event: "data", listener: (chunk: Buffer) => void): unknown;
}

/** One change list item, pre-rendered per viewport width. */

export class FileDiffPanel {
  private readonly files: PanelFile[];
  private readonly theme: Theme;
  private readonly keys: KeybindingsManager;
  private readonly onChange: () => void;
  private readonly onDone: () => void;
  private readonly msgs: Messages;
  private readonly fg: ColorFn;
  private selected = 0;
  private view: View = "list";
  private diffScroll = 0;
  /** Files per page in the list view. */
  static readonly PAGE_SIZE = 10;
  private readonly wheel = new MouseWheelParser();
  private readonly mouseSource: MouseInputSource;
  /**
   * Viewport height while the panel is used as a modal overlay. Padding the
   * panel to this height makes the overlay opaque: blank rows replace the
   * transcript and editor underneath instead of letting them show through.
   */
  private readonly viewportHeight: () => number;
  private mouseDetach: (() => void) | undefined;

  constructor(
    files: PanelFile[],
    theme: Theme,
    keys: KeybindingsManager,
    onChange: () => void,
    onDone: () => void,
    mouseSource?: MouseInputSource,
    msgs: Messages = enMessages,
    viewportHeight: () => number = () => 0,
  ) {
    this.files = groupFilesByGitStatus(files);
    this.theme = theme;
    this.keys = keys;
    this.onChange = onChange;
    this.onDone = onDone;
    this.mouseSource = mouseSource ?? process.stdin;
    this.msgs = msgs;
    this.viewportHeight = viewportHeight;
    // theme.fg needs `this`; success is overridden to a fixed green so
    // additions don't read as theme-yellow.
    this.fg = withGreenSuccess((color, text) => this.theme.fg(color, text));
    this.attachMouse();
  }

  // ------------------------------------------------------------------ input

  handleInput(data: string): void {
    const k = this.keys;

    if (this.view === "list") {
      if (k.matches(data, "tui.select.up") || data === "k") this.moveSelection(-1);
      else if (k.matches(data, "tui.select.down") || data === "j") this.moveSelection(1);
      else if (k.matches(data, "tui.select.pageUp")) this.pageMove(-1);
      else if (k.matches(data, "tui.select.pageDown")) this.pageMove(1);
      else if (k.matches(data, "tui.select.confirm")) this.openDiff();
      else if (k.matches(data, "tui.select.cancel") || data === "\x1b") this.onDone();
      return;
    }

    // diff view
    if (k.matches(data, "tui.select.up")) this.scrollDiff(-1);
    else if (k.matches(data, "tui.select.down")) this.scrollDiff(1);
    else if (k.matches(data, "tui.select.pageUp")) this.scrollDiff(-10);
    else if (k.matches(data, "tui.select.pageDown")) this.scrollDiff(10);
    else if (k.matches(data, "tui.select.cancel") || data === "\x1b" || data === "\x1b[D" || data === "h") {
      this.view = "list";
      this.diffScroll = 0;
      this.onChange();
    } else if (k.matches(data, "tui.select.confirm")) {
      this.onDone();
    }
  }

  private get page(): number {
    return Math.floor(this.selected / FileDiffPanel.PAGE_SIZE);
  }

  private get pageCount(): number {
    return Math.max(1, Math.ceil(this.files.length / FileDiffPanel.PAGE_SIZE));
  }

  /** Page-based navigation: jump to the first item of the target page. */
  private pageMove(delta: number): void {
    const target = Math.min(this.pageCount - 1, Math.max(0, this.page + delta));
    const next = Math.min(this.files.length - 1, target * FileDiffPanel.PAGE_SIZE);
    if (next !== this.selected) {
      this.selected = next;
      this.onChange();
    }
  }

  private moveSelection(delta: number): void {
    const next = Math.min(this.files.length - 1, Math.max(0, this.selected + delta));
    if (next !== this.selected) {
      this.selected = next;
      this.onChange();
    }
  }

  private openDiff(): void {
    this.view = "diff";
    this.diffScroll = 0;
    this.onChange();
  }

  private scrollDiff(delta: number): void {
    const total = this.diffLineCount();
    const next = Math.min(Math.max(0, this.diffScroll + delta), Math.max(0, total - 1));
    if (next !== this.diffScroll) {
      this.diffScroll = next;
      this.onChange();
    }
  }

  // ------------------------------------------------------------------ mouse

  private attachMouse(): void {
    try {
      const listener = (chunk: Buffer) => {
        const delta = this.wheel.push(chunk.toString());
        if (delta === 0) return;
        if (this.view === "list") this.moveSelection(delta);
        else this.scrollDiff(delta);
      };
      this.mouseSource.on("data", listener);
      this.mouseDetach = () => {
        this.mouseSource.removeListener("data", listener);
      };
    } catch {
      this.mouseDetach = undefined; // no stdin access — keyboard only
    }
  }

  dispose(): void {
    this.mouseDetach?.();
    this.mouseDetach = undefined;
  }

  // ---------------------------------------------------------------- render

  invalidate(): void {
    // stateless rendering — nothing to clear
  }

  private diffLineCount(): number {
    const file = this.files[this.selected];
    if (!file) return 0;
    return buildDiffViewLines(file.change, this.fg, this.msgs).length;
  }

  render(width: number): string[] {
    const fg = this.fg;
    const lines = this.view === "list" ? this.renderList(fg) : this.renderDiff(width, fg);

    // `ctx.ui.custom({ overlay: true })` composites only the lines returned
    // here. Without this padding, a short list leaves the previous transcript
    // and the editor visible below it, which looks like the panel is offset.
    // Empty overlay lines are intentionally opaque to the compositor.
    const height = Math.max(0, Math.floor(this.viewportHeight()));
    while (lines.length < height) lines.push("");
    return lines;
  }

  private renderList(
    fg: (color: Parameters<NonNullable<Theme["fg"]>>[0], text: string) => string,
  ): string[] {
    const out: string[] = [];
    const total = this.files.length;
    const page = this.page;
    const pageCount = this.pageCount;
    out.push(
      fg("accent", `pi-file-diff · ${this.msgs.filesChanged(total)} · Page ${page + 1}/${pageCount}`),
    );

    const pageStart = page * FileDiffPanel.PAGE_SIZE;
    const pageEnd = Math.min(total, pageStart + FileDiffPanel.PAGE_SIZE);
    const hasGitInfo = this.files.some((f) => f.tracked !== undefined);
    let lastGroup: boolean | undefined;

    for (let i = pageStart; i < pageEnd; i++) {
      const file = this.files[i]!;
      if (hasGitInfo) {
        const group = file.tracked === true;
        if (group !== lastGroup) {
          out.push(fg("muted", group ? "git tracked files:" : "git untracked files:"));
          lastGroup = group;
        }
      }
      out.push(this.renderListLine(i, file, fg));
    }

    out.push(fg("dim", this.msgs.listFooter));
    return out;
  }

  private renderListLine(
    index: number,
    file: PanelFile,
    fg: (color: Parameters<NonNullable<Theme["fg"]>>[0], text: string) => string,
  ): string {
    const c = file.change;
    const status = c.fileStatus ?? (c.kind === "write" ? "A" : "M");
    const icon = status === "A" ? "+" : status === "D" ? "-" : "~";
    const iconColor = status === "A" ? "success" : status === "D" ? "error" : "warning";
    const pathText = status === "D" ? "\x1b[9m" + file.path + "\x1b[29m" : file.path;
    let line = fg(iconColor, icon) + " " + fg("dim", pathText);
    const counts: string[] = [];
    if (c.insertions > 0) counts.push(fg("success", `+${c.insertions}`));
    if (c.deletions > 0) counts.push(fg("error", `-${c.deletions}`));
    if (counts.length > 0) line += "  " + counts.join(" ");
    if (c.kind === "bash") line += fg("dim", this.msgs.shellMarker);
    else if (c.shellTouched) line += fg("dim", this.msgs.shellTouchedMarker);
    if (status === "A") line += fg("dim", this.msgs.newFileMarker);
    else if (status === "D") line += fg("dim", this.msgs.deletedFileMarker);

    return index === this.selected ? REVERSE_ON + line + REVERSE_OFF : line;
  }

  private renderDiff(
    width: number,
    fg: (color: Parameters<NonNullable<Theme["fg"]>>[0], text: string) => string,
  ): string[] {
    const file = this.files[this.selected];
    const out: string[] = [];
    if (!file) return out;

    const fit = (line: string) => (width > 0 && line.length > width ? line.slice(0, width) : line);

    const c = file.change;
    const status = c.fileStatus ?? (c.kind === "write" ? "A" : "M");
    const icon = status === "A" ? "+" : status === "D" ? "-" : "~";
    const counts: string[] = [];
    if (c.insertions > 0) counts.push(`+${c.insertions}`);
    if (c.deletions > 0) counts.push(`-${c.deletions}`);
    const title =
      status === "D"
        ? `${icon} \x1b[9m${file.path}\x1b[29m`
        : `${icon} ${file.path}`;
    out.push(
      fg("accent", title) + (counts.length > 0 ? fg("muted", "  " + counts.join(" ")) : ""),
    );
    if (status === "A") out.push(fg("dim", this.msgs.newFileFull));
    else if (status === "D") out.push(fg("dim", this.msgs.deletedFileFull));

    if (c.shellTouched && !c.bashDiff) {
      out.push(fg("warning", this.msgs.shellIncomplete));
    }

    const diffLines = buildDiffViewLines(c, fg, this.msgs);
    const visible = 20;
    const top = Math.min(this.diffScroll, Math.max(0, diffLines.length - visible));
    for (let i = top; i < Math.min(diffLines.length, top + visible); i++) {
      out.push("  " + fit(diffLines[i]!));
    }
    if (diffLines.length > visible) {
      out.push(fg("dim", `(${top + 1}-${Math.min(diffLines.length, top + visible)} / ${diffLines.length})`));
    }

    out.push(fg("dim", this.msgs.diffFooter));
    return out;
  }
}

/** Keep ChangeKind referenced for type consumers. */
export type { ChangeKind };

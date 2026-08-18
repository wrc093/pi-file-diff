/**
 * pi-file-diff — pi entry renderer.
 *
 * Thin wrapper that turns a SummaryPayload into colored TUI text. Entries are
 * display-only: they never enter LLM context, so appending a summary can
 * never wake the agent or trigger extra runs (unlike sendMessage, which
 * queues into the agent delivery machinery).
 */

import type { EntryRenderOptions, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { enMessages, type Messages } from "./i18n.ts";
import { withGreenSuccess } from "./colors.ts";
import { buildSummaryText, isSummaryPayload, type ColorFn } from "./render.ts";

export function createSummaryEntryRenderer(msgs: Messages = enMessages) {
  return (entry: { data?: unknown }, _options: EntryRenderOptions, theme: Theme): Text => {
    try {
      if (!isSummaryPayload(entry.data)) {
        return new Text("\u26a0 Invalid file-diff summary payload", 0, 0);
      }
      // theme.fg relies on `this` (reads this.fgColors), so wrap it instead
      // of passing the bare method reference around; success is overridden
      // to a fixed green so additions don't read as theme-yellow.
      const fg: ColorFn = withGreenSuccess((color, text) => theme.fg(color, text));
      const lines = buildSummaryText(entry.data, fg, msgs);
      return new Text(lines.join("\n"), 0, 0);
    } catch {
      return new Text("\u26a0 file-diff summary could not be rendered", 0, 0);
    }
  };
}

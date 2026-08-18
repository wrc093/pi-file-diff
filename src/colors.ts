/**
 * pi-file-diff — Color overrides.
 *
 * The pi dark theme maps `success` to `#b5bd68` (olive-yellow-green), which
 * makes "added" content read as yellow. We therefore override the success
 * color with a fixed, unambiguous green for our UI (additions). All other
 * colors keep following the user's theme.
 */

/** Fixed pure green for additions (works on dark and light themes). */
export const ADDED_GREEN = "\x1b[38;2;96;200;112m";

import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ColorFn } from "./render.ts";

type ThemeFg = Theme["fg"];

/**
 * Wrap a theme fg function: `success` renders as ADDED_GREEN, everything
 * else passes through. `themeFg` must already be this-bound (theme.fg reads
 * this.fgColors) — pass an arrow function like (c, t) => theme.fg(c, t).
 */
export function withGreenSuccess(themeFg: ThemeFg): ColorFn {
  return (color, text) => (color === "success" ? ADDED_GREEN + text : themeFg(color, text));
}

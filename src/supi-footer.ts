/**
 * Optional placement in SuPi's footer (`@mrclrchtr/supi-extras`) without a dependency.
 *
 * SuPi keeps footer contributions in a Map on `globalThis` under this symbol so that separate
 * module copies share it. A contribution with the same key as a Pi status hides that status, so
 * the status stays as the fallback for Pi's built-in footer. If SuPi changes this protocol, the
 * contribution is simply not rendered and the status line remains.
 */

import type { FooterColor, GlyphMode } from "./rate-limit-status.ts";

const REGISTRY = Symbol.for("@mrclrchtr/supi-core/footer-contributions");

export interface SupiFooterContext {
  style: (color: FooterColor, text: string) => string;
  glyphMode: GlyphMode;
}

interface SupiFooterContribution {
  key: string;
  placement: "stats-end";
  priority?: number;
  render: (ctx?: SupiFooterContext) => string;
}

function registry(): Map<string, SupiFooterContribution> {
  const scope = globalThis as Record<symbol, unknown>;
  if (!(scope[REGISTRY] instanceof Map)) scope[REGISTRY] = new Map();
  return scope[REGISTRY] as Map<string, SupiFooterContribution>;
}

/** Show `render` after context usage on SuPi's session line. */
export function registerSupiFooter(key: string, render: (ctx: SupiFooterContext) => string | undefined): void {
  registry().set(key, {
    key,
    placement: "stats-end",
    // SuPi calls render without a context outside its footer; such callers get nothing.
    render: (ctx) => (ctx ? (render(ctx) ?? "") : ""),
  });
}

export function unregisterSupiFooter(key: string): void {
  registry().delete(key);
}

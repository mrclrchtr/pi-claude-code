/**
 * Footer text for the plan-limit windows Claude Code reports with each turn
 * (`claude-code.rate-limit` diagnostic), so the user sees how much of the
 * subscription is used before a request is rejected.
 */

import type { RateLimitInfo } from "./billing.ts";

export const RATE_LIMIT_DIAGNOSTIC = "claude-code.rate-limit";

/** Theme colors the footer uses; all are Pi theme foreground tokens. */
export type FooterColor = "accent" | "dim" | "muted" | "text" | "success" | "warning" | "error";
export type GlyphMode = "nerd" | "unicode" | "ascii";
export type Style = (color: FooterColor, text: string) => string;

interface LimitWindow {
  name: string;
  status?: string;
  utilization?: number;
  resetsAt?: number;
}

function windowsOf(info: RateLimitInfo): LimitWindow[] {
  const unified = info.unifiedWindows;
  if (unified && typeof unified === "object" && !Array.isArray(unified)) {
    const listed = Object.entries(unified as Record<string, unknown>).flatMap(([name, value]): LimitWindow[] => {
      if (!value || typeof value !== "object") return [];
      const window = value as Record<string, unknown>;
      return [
        {
          name,
          status: typeof window.status === "string" ? window.status : undefined,
          utilization: typeof window.utilization === "number" ? window.utilization : undefined,
          resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : undefined,
        },
      ];
    });
    if (listed.length) return listed;
  }
  if (!info.rateLimitType) return [];
  return [
    {
      name: info.rateLimitType,
      status: info.status,
      utilization: typeof info.utilization === "number" ? info.utilization : undefined,
      resetsAt: info.resetsAt,
    },
  ];
}

// Anthropic reports `seven_day_overage_included` only for Fable requests, as its own weekly window.
const WINDOW_LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_overage_included: "Fable",
  seven_day_opus: "Opus",
  seven_day_sonnet: "Sonnet",
};
const WINDOW_ORDER = Object.keys(WINDOW_LABELS);

function windowLabel(name: string): string {
  return WINDOW_LABELS[name] ?? name.replace(/^five_hour/u, "5h").replace(/^seven_day/u, "7d").replaceAll("_", " ");
}

function windowRank(name: string): number {
  const index = WINDOW_ORDER.indexOf(name);
  return index < 0 ? WINDOW_ORDER.length : index;
}

const GLYPHS: Record<GlyphMode, { icon: string; reset: string; bar: boolean }> = {
  nerd: { icon: "\u{F06A9} ", reset: "\u{F051F} ", bar: true }, // nf-md-robot, nf-md-timer_sand
  unicode: { icon: "", reset: "↻ ", bar: true },
  ascii: { icon: "", reset: "reset ", bar: false },
};

const BAR_CELLS = 5;

function severity(window: LimitWindow): "normal" | "warning" | "error" {
  const used = window.utilization ?? 0;
  if (window.status === "rejected" || used >= 0.9) return "error";
  if (window.status === "allowed_warning" || used >= 0.75) return "warning";
  return "normal";
}

function resetLabel(resetsAt: number, now: number, timeZone?: string, locale?: string): string {
  const date = new Date(resetsAt * 1_000);
  const withinDay = date.getTime() - now < 24 * 60 * 60 * 1_000;
  return new Intl.DateTimeFormat(locale, {
    ...(withinDay ? {} : { weekday: "short" }),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(date);
}

export interface RenderOptions {
  style: Style;
  glyphMode: GlyphMode;
  now?: number;
  timeZone?: string;
  locale?: string;
}

/**
 * The latest known value of every plan-limit window. A window keeps its value after a response
 * that does not report it (Fable's window is absent from Opus responses) until it resets.
 */
export class RateLimitState {
  private readonly windows = new Map<string, LimitWindow>();
  private current = new Set<string>();
  private usingCredits = false;

  /** Merge one response's report. Returns false when it carries no window. */
  update(info: RateLimitInfo): boolean {
    const reported = windowsOf(info);
    if (!reported.length) return false;
    for (const window of reported) this.windows.set(window.name, window);
    this.current = new Set(reported.map((window) => window.name));
    this.usingCredits = info.isUsingOverage === true;
    return true;
  }

  /** For example `󰚩 7d ▰▰▰▰▱ 89% · Fable ▰▰▰▰▰ 99% · 󰔟 Sat 07:00`; undefined when nothing is known. */
  render({ style, glyphMode, now = Date.now(), timeZone, locale }: RenderOptions): string | undefined {
    const glyphs = GLYPHS[glyphMode];
    const shown = [...this.windows.values()]
      .filter((window) => window.resetsAt === undefined || window.resetsAt * 1_000 > now)
      .filter((window) => window.utilization !== undefined || window.status === "rejected")
      .sort((left, right) => windowRank(left.name) - windowRank(right.name));
    if (!shown.length) return undefined;

    const parts = shown.map((window) => {
      const level = severity(window);
      // Values not confirmed by the latest response are dimmed: they may be out of date.
      const stale = !this.current.has(window.name);
      const color = (normal: FooterColor): FooterColor => (stale ? "dim" : level === "normal" ? normal : level);
      const label = style(stale ? "dim" : "muted", windowLabel(window.name));
      if (window.utilization === undefined) return `${label} ${style(color("muted"), "limit reached")}`;
      const percent = style(color("muted"), `${Math.round(window.utilization * 100)}%`);
      if (!glyphs.bar) return `${label} ${percent}`;
      const filled = Math.min(
        BAR_CELLS,
        Math.max(window.utilization > 0 ? 1 : 0, Math.round(window.utilization * BAR_CELLS)),
      );
      const bar = style(color("accent"), "▰".repeat(filled)) + style("dim", "▱".repeat(BAR_CELLS - filled));
      return `${label} ${bar} ${percent}`;
    });

    // The window closest to its limit decides when work can continue.
    const tightest = shown.reduce((best, window) =>
      (window.utilization ?? 1) > (best.utilization ?? 1) ? window : best,
    );
    if (tightest.resetsAt !== undefined) {
      parts.push(style("muted", `${glyphs.reset}${resetLabel(tightest.resetsAt, now, timeZone, locale)}`));
    }
    if (this.usingCredits) parts.push(style("warning", "usage credits"));
    return style("muted", glyphs.icon) + parts.join(style("dim", " · "));
  }
}

/** The rate-limit diagnostic of an assistant message, if it has one. */
export function rateLimitInfoOf(message: unknown): RateLimitInfo | undefined {
  if (!message || typeof message !== "object") return undefined;
  const diagnostics = (message as { diagnostics?: unknown }).diagnostics;
  if (!Array.isArray(diagnostics)) return undefined;
  const diagnostic = diagnostics.findLast(
    (item) => item && typeof item === "object" && (item as { type?: unknown }).type === RATE_LIMIT_DIAGNOSTIC,
  ) as { details?: unknown } | undefined;
  const details = diagnostic?.details;
  return details && typeof details === "object" ? (details as RateLimitInfo) : undefined;
}

/**
 * Icon mode when no SuPi footer supplies one. Same rule as SuPi's `auto`: Nerd Font glyphs on a
 * local UTF-8 terminal, Unicode over SSH (the font lives on the client), ASCII otherwise.
 */
export function detectGlyphMode(
  env: NodeJS.ProcessEnv = process.env,
  isTTY: boolean = process.stdout.isTTY === true,
): GlyphMode {
  if (env.TERM === "dumb" || !isTTY) return "ascii";
  const locale = env.LC_ALL || env.LC_CTYPE || env.LANG;
  if (locale && !/utf-?8/iu.test(locale)) return "ascii";
  if (env.SSH_TTY || env.SSH_CONNECTION) return "unicode";
  return "nerd";
}

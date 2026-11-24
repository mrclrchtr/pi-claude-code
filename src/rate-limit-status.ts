/**
 * Footer text for the plan-limit status Claude Code reports with each turn
 * (`claude-code.rate-limit` diagnostic), so the user sees how much of the
 * subscription window is used before a request is rejected.
 */

import type { RateLimitInfo } from "./billing.ts";

export const RATE_LIMIT_DIAGNOSTIC = "claude-code.rate-limit";

export interface RateLimitStatus {
  text: string;
  /** "error" once a window rejects requests, "warning" once Claude Code warns about one. */
  severity: "normal" | "warning" | "error";
}

interface LimitWindow {
  name: string;
  status?: string;
  utilization?: number;
  resetsAt?: number;
}

function windows(info: RateLimitInfo): LimitWindow[] {
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

/** `seven_day_opus` -> `7d opus`. */
function windowLabel(name: string): string {
  return name.replace(/^five_hour/u, "5h").replace(/^seven_day/u, "7d").replaceAll("_", " ");
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

const SEVERITY_RANK = { normal: 0, warning: 1, error: 2 } as const;

function windowSeverity(status: string | undefined): RateLimitStatus["severity"] {
  if (status === "rejected") return "error";
  if (status === "allowed_warning") return "warning";
  return "normal";
}

export function formatRateLimitStatus(
  info: RateLimitInfo,
  now = Date.now(),
  timeZone?: string,
  locale?: string,
): RateLimitStatus | undefined {
  const shown = windows(info).filter((window) => window.utilization !== undefined || window.status === "rejected");
  if (!shown.length) return undefined;

  let severity: RateLimitStatus["severity"] = windowSeverity(info.status);
  for (const window of shown) {
    const candidate = windowSeverity(window.status);
    if (SEVERITY_RANK[candidate] > SEVERITY_RANK[severity]) severity = candidate;
  }

  const parts = shown.map((window) =>
    window.utilization === undefined
      ? `${windowLabel(window.name)} limit reached`
      : `${windowLabel(window.name)} ${Math.round(window.utilization * 100)}%`,
  );
  // The window closest to its limit decides when work can continue.
  const tightest = shown.reduce((best, window) =>
    (window.utilization ?? 1) > (best.utilization ?? 1) ? window : best,
  );
  const resetsAt = tightest.resetsAt ?? info.resetsAt;
  if (resetsAt !== undefined) parts.push(`reset ${resetLabel(resetsAt, now, timeZone, locale)}`);
  if (info.isUsingOverage === true) parts.push("usage credits");
  return { text: `Claude ${parts.join(" · ")}`, severity };
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

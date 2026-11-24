import assert from "node:assert/strict";
import test from "node:test";
import { formatRateLimitStatus, rateLimitInfoOf } from "../src/rate-limit-status.ts";

const NOW = Date.UTC(2026, 10, 24, 12, 0);
const IN_TWO_DAYS = NOW / 1_000 + 2 * 24 * 60 * 60 + 11 * 60 * 60; // Thu 23:00 UTC

test("shows the weekly window with its utilization, reset, and a warning", () => {
  assert.deepEqual(
    formatRateLimitStatus(
      {
        status: "allowed_warning",
        rateLimitType: "seven_day",
        utilization: 0.86,
        resetsAt: IN_TWO_DAYS,
        isUsingOverage: false,
      },
      NOW,
      "UTC",
      "en-US",
    ),
    { text: "Claude 7d 86% · reset Thu 23:00", severity: "warning" },
  );
});

test("lists every unified window and takes the reset of the tightest one", () => {
  const status = formatRateLimitStatus(
    {
      status: "allowed",
      rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0.4, resetsAt: NOW / 1_000 + 3 * 60 * 60, status: "allowed" },
        seven_day: { utilization: 0.7, resetsAt: IN_TWO_DAYS, status: "allowed" },
      },
    },
    NOW,
    "UTC",
    "en-US",
  );
  assert.deepEqual(status, { text: "Claude 5h 40% · 7d 70% · reset Thu 23:00", severity: "normal" });
});

test("reports a rejected window without utilization as reached, and usage-credit charges", () => {
  const status = formatRateLimitStatus(
    { status: "rejected", rateLimitType: "five_hour", resetsAt: NOW / 1_000 + 90 * 60, isUsingOverage: true },
    NOW,
    "UTC",
    "en-US",
  );
  assert.deepEqual(status, { text: "Claude 5h limit reached · reset 13:30 · usage credits", severity: "error" });
});

test("shows nothing when Claude Code reports no utilization", () => {
  assert.equal(formatRateLimitStatus({ status: "allowed", rateLimitType: "seven_day" }, NOW), undefined);
});

test("reads the latest rate-limit diagnostic of a message", () => {
  const info = { status: "allowed", rateLimitType: "seven_day", utilization: 0.5 };
  assert.deepEqual(
    rateLimitInfoOf({
      diagnostics: [
        { type: "claude-code.turn-relay", details: {} },
        { type: "claude-code.rate-limit", details: info },
      ],
    }),
    info,
  );
  assert.equal(rateLimitInfoOf({ diagnostics: [] }), undefined);
});

import assert from "node:assert/strict";
import test from "node:test";
import { detectGlyphMode, RateLimitState, rateLimitInfoOf } from "../src/rate-limit-status.ts";
import { registerSupiFooter, unregisterSupiFooter } from "../src/supi-footer.ts";

const NOW = Date.UTC(2026, 10, 24, 12, 0);
const IN_TWO_DAYS = NOW / 1_000 + 2 * 24 * 60 * 60 + 11 * 60 * 60; // Thu 23:00 UTC
const plain = (_color: string, text: string) => text;
const tagged = (color: string, text: string) => `<${color}>${text}`;
const render = (state: RateLimitState, options: Partial<Parameters<RateLimitState["render"]>[0]> = {}) =>
  state.render({ style: plain, glyphMode: "unicode", now: NOW, timeZone: "UTC", locale: "en-US", ...options });

// What Claude Code reports for a Fable response: the account window and Fable's own window.
const fable = {
  status: "allowed_warning",
  rateLimitType: "seven_day",
  unifiedWindows: {
    seven_day: { utilization: 0.89, resetsAt: IN_TWO_DAYS, status: "allowed_warning" },
    seven_day_overage_included: { utilization: 0.99, resetsAt: IN_TWO_DAYS, status: "allowed_warning" },
  },
};
const opus = {
  status: "allowed_warning",
  rateLimitType: "seven_day",
  unifiedWindows: { seven_day: { utilization: 0.9, resetsAt: IN_TWO_DAYS, status: "allowed_warning" } },
};

test("shows each window with a bar, its utilization, and the reset of the tightest window", () => {
  const state = new RateLimitState();
  assert.equal(state.update(fable), true);
  assert.equal(render(state), "7d ▰▰▰▰▱ 89% · Fable ▰▰▰▰▰ 99% · ↻ Thu 23:00");
  assert.equal(
    render(state, { glyphMode: "nerd" }),
    "\u{F06A9} 7d ▰▰▰▰▱ 89% · Fable ▰▰▰▰▰ 99% · \u{F051F} Thu 23:00",
  );
  assert.equal(render(state, { glyphMode: "ascii" }), "7d 89% · Fable 99% · reset Thu 23:00");
});

test("keeps Fable's window after an Opus response, dimmed as possibly out of date", () => {
  const state = new RateLimitState();
  state.update(fable);
  state.update(opus);
  assert.equal(render(state), "7d ▰▰▰▰▰ 90% · Fable ▰▰▰▰▰ 99% · ↻ Thu 23:00");
  const styled = render(state, { style: tagged })!;
  assert.match(styled, /<muted>7d <error>▰▰▰▰▰<dim> <error>90%/u);
  assert.match(styled, /<dim>Fable <dim>▰▰▰▰▰<dim> <dim>99%/u);
});

test("colors by Anthropic's status and drops windows that have reset", () => {
  const state = new RateLimitState();
  state.update({
    status: "allowed",
    rateLimitType: "five_hour",
    unifiedWindows: {
      five_hour: { utilization: 0.4, resetsAt: NOW / 1_000 + 3 * 60 * 60, status: "allowed" },
      seven_day: { utilization: 0.5, resetsAt: NOW / 1_000 - 60, status: "allowed" },
    },
  });
  assert.equal(render(state, { style: tagged }), "<muted><muted>5h <accent>▰▰<dim>▱▱▱ <muted>40%<dim> · <muted>↻ 15:00");
});

test("reports a rejected window without utilization as reached, and usage-credit charges", () => {
  const state = new RateLimitState();
  state.update({ status: "rejected", rateLimitType: "five_hour", resetsAt: NOW / 1_000 + 90 * 60, isUsingOverage: true });
  assert.equal(render(state), "5h limit reached · ↻ 13:30 · usage credits");
});

test("shows nothing until Claude Code reports a window with utilization", () => {
  const state = new RateLimitState();
  assert.equal(state.update({ status: "allowed" }), false);
  state.update({ status: "allowed", rateLimitType: "seven_day" });
  assert.equal(render(state), undefined);
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

test("picks Nerd Font glyphs only on a local UTF-8 terminal", () => {
  assert.equal(detectGlyphMode({ LANG: "en_US.UTF-8" }, true), "nerd");
  assert.equal(detectGlyphMode({ LANG: "en_US.UTF-8", SSH_TTY: "/dev/ttys001" }, true), "unicode");
  assert.equal(detectGlyphMode({ LANG: "C" }, true), "ascii");
  assert.equal(detectGlyphMode({ LANG: "en_US.UTF-8" }, false), "ascii");
});

test("registers in SuPi's shared footer registry with SuPi's render context", () => {
  const registry = () =>
    (globalThis as Record<symbol, unknown>)[Symbol.for("@mrclrchtr/supi-core/footer-contributions")] as Map<
      string,
      { placement: string; render: (ctx?: unknown) => string }
    >;
  registerSupiFooter("claude-code-test", (ctx) => ctx.style("accent", ctx.glyphMode));
  try {
    const contribution = registry().get("claude-code-test")!;
    assert.equal(contribution.placement, "stats-end");
    assert.equal(contribution.render({ style: tagged, glyphMode: "nerd" }), "<accent>nerd");
    assert.equal(contribution.render(), "");
  } finally {
    unregisterSupiFooter("claude-code-test");
  }
  assert.equal(registry().has("claude-code-test"), false);
});

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { closeClaudeProcesses, getClaudeStatus } from "./claude-cli.ts";
import { claudeCodeEnv, createClaudeCodeProvider, PROVIDER_ID } from "./provider.ts";
import { detectGlyphMode, RateLimitState, rateLimitInfoOf } from "./rate-limit-status.ts";
import { registerSupiFooter, unregisterSupiFooter } from "./supi-footer.ts";

const STATUS_KEY = "claude-code";

/** Merge the plan-limit report of a Claude Code assistant message. Returns false if it has none. */
function recordRateLimit(state: RateLimitState, message: unknown): boolean {
  if ((message as { provider?: unknown } | undefined)?.provider !== PROVIDER_ID) return false;
  const info = rateLimitInfoOf(message);
  return !!info && state.update(info);
}

/**
 * Show the plan limits in SuPi's session line when SuPi's footer is installed, otherwise as a
 * Pi status line. Both use the same key, so SuPi hides the status line in favor of its own.
 */
function showRateLimits(state: RateLimitState, ctx: ExtensionContext): void {
  const theme = ctx.ui.theme;
  const text = state.render({ style: (color, value) => theme.fg(color, value), glyphMode: detectGlyphMode() });
  ctx.ui.setStatus(STATUS_KEY, text);
  registerSupiFooter(STATUS_KEY, (footer) => state.render(footer));
}

export default function claudeCodeExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createClaudeCodeProvider());
  const rateLimits = new RateLimitState();

  // Pi cleans up session resources when a session ends, but /reload keeps the session and
  // loads a fresh copy of this module. Close this copy's warm process for the session, which the
  // new copy cannot reuse, instead of leaving it alive until it expires.
  pi.on("session_shutdown", async (event, ctx) => {
    // The footer contribution reads this module copy's state; a reload registers its own.
    unregisterSupiFooter(STATUS_KEY);
    if (event.reason === "reload") await closeClaudeProcesses(ctx.sessionManager.getSessionId());
  });

  // Plan limits are per account, so known windows stay shown across sessions and models.
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant" && recordRateLimit(rateLimits, event.message)) {
      showRateLimits(rateLimits, ctx);
    }
  });
  pi.on("session_start", (_event, ctx) => {
    let found = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "message" && recordRateLimit(rateLimits, entry.message)) found = true;
    }
    if (found) showRateLimits(rateLimits, ctx);
  });

  pi.registerCommand("claude-code-status", {
    description: "Check the Claude Code executable and subscription login",
    handler: async (_args, ctx) => {
      const status = await getClaudeStatus(claudeCodeEnv(), ctx.signal);
      if (!status.available || !status.loggedIn) {
        ctx.ui.notify(status.detail ?? "Claude Code is not ready", "error");
        return;
      }
      const plan = status.plan ? ` (${status.plan})` : "";
      ctx.ui.notify(`Claude Code is installed and logged in${plan}`, "info");
    },
  });
}

export { createClaudeCodeProvider } from "./provider.ts";
export { streamClaudeCode } from "./stream.ts";

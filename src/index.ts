import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { closeClaudeProcesses, getClaudeStatus } from "./claude-cli.ts";
import { claudeCodeEnv, createClaudeCodeProvider, PROVIDER_ID } from "./provider.ts";
import { formatRateLimitStatus, rateLimitInfoOf } from "./rate-limit-status.ts";

const STATUS_KEY = "claude-code";

/** Show the plan-limit status of a Claude Code assistant message in the footer. Returns false if it has none. */
function showRateLimit(message: unknown, ctx: ExtensionContext): boolean {
  if ((message as { provider?: unknown } | undefined)?.provider !== PROVIDER_ID) return false;
  const info = rateLimitInfoOf(message);
  const status = info && formatRateLimitStatus(info);
  if (!status) return false;
  const color = status.severity === "normal" ? "dim" : status.severity;
  ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, status.text));
  return true;
}

export default function claudeCodeExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createClaudeCodeProvider());

  // Pi cleans up session resources when a session ends, but /reload keeps the session and
  // loads a fresh copy of this module. Close this copy's warm process for the session, which the
  // new copy cannot reuse, instead of leaving it alive until it expires.
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") await closeClaudeProcesses(ctx.sessionManager.getSessionId());
  });

  // Plan limits are per account, so the latest status stays shown across sessions and models.
  pi.on("message_end", (event, ctx) => {
    if (event.message.role === "assistant") showRateLimit(event.message, ctx);
  });
  pi.on("session_start", (_event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index]!;
      if (entry.type === "message" && showRateLimit(entry.message, ctx)) return;
    }
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

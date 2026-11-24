import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { closeClaudeProcesses, getClaudeStatus } from "./claude-cli.ts";
import { claudeCodeEnv, createClaudeCodeProvider } from "./provider.ts";

export default function claudeCodeExtension(pi: ExtensionAPI): void {
  pi.registerProvider(createClaudeCodeProvider());

  // Pi cleans up session resources when a session ends, but /reload keeps the session and
  // loads a fresh copy of this module. Close this copy's warm process for the session, which the
  // new copy cannot reuse, instead of leaving it alive until it expires.
  pi.on("session_shutdown", async (event, ctx) => {
    if (event.reason === "reload") await closeClaudeProcesses(ctx.sessionManager.getSessionId());
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

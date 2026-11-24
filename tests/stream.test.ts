import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cachedClaudeProcessCount, closeClaudeProcesses } from "../src/claude-cli.ts";
import { CLAUDE_CODE_MODELS } from "../src/model-catalog.ts";
import { streamClaudeCode } from "../src/stream.ts";

test("hands Pi a tool call for a tool it never declared", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-stream-"));
  const executable = join(root, "fake-claude.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import readline from "node:readline";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "test"}));
  process.exit(0);
}
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request" && frame.request?.subtype === "initialize") {
    console.log(JSON.stringify({type: "control_response", response: {subtype: "success", request_id: frame.request_id, response: {models: []}}}));
    continue;
  }
  if (frame.type !== "user") continue;
  const usage = {input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
  const content = [{type: "tool_use", id: "tool_fake", name: "mcp__pi__aggregate_rum_events", input: {query: "*"}}];
  const events = [
    {type: "message_start", message: {id: "m_fake", model: "claude-opus-5-6", role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: {type: "tool_use", id: "tool_fake", name: "mcp__pi__aggregate_rum_events", input: {}}},
    {type: "content_block_delta", index: 0, delta: {type: "input_json_delta", partial_json: '{"query":"*"}'}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "tool_use"}, usage},
    {type: "message_stop"}
  ];
  for (const event of events) console.log(JSON.stringify({type: "stream_event", event}));
  console.log(JSON.stringify({type: "assistant", message: {id: "m_fake", role: "assistant", content, stop_reason: "tool_use", usage}}));
  console.log(JSON.stringify({type: "result", subtype: "error_max_turns", is_error: true, usage}));
}
`,
    "utf8",
  );
  await chmod(executable, 0o755);

  try {
    const model = CLAUDE_CODE_MODELS.find((candidate) => candidate.id === "claude-opus-5-5")!;
    const stream = streamClaudeCode(
      model,
      {
        systemPrompt: "system",
        messages: [{ role: "user", content: [{ type: "text", text: "count errors" }], timestamp: 0 }],
        tools: [{ name: "mcp__datadog__aggregate_rum_events", description: "Aggregate RUM", parameters: { type: "object" } }],
      } as never,
      { env: { PI_CLAUDE_CODE_COMMAND: executable }, timeoutMs: 5_000, cacheRetention: "none" } as never,
    );
    const message = await stream.result();
    assert.equal(message.stopReason, "toolUse", message.errorMessage);
    // Replay tags turns with the model that answered, not the requested alias.
    assert.equal(message.responseModel, "claude-opus-5-6");
    assert.deepEqual(
      message.content.map((block) => (block.type === "toolCall" ? [block.name, block.arguments] : block.type)),
      [["aggregate_rum_events", { query: "*" }]],
    );
  } finally {
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true });
  }
});

test("passes the output budget to Claude Code, defaulting to the model's maxTokens", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-stream-"));
  const executable = join(root, "fake-claude.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import readline from "node:readline";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "test"}));
  process.exit(0);
}
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request" && frame.request?.subtype === "initialize") {
    console.log(JSON.stringify({type: "control_response", response: {subtype: "success", request_id: frame.request_id, response: {models: []}}}));
    continue;
  }
  if (frame.type !== "user") continue;
  const text = String(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS);
  const usage = {input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
  const content = [{type: "text", text}];
  const events = [
    {type: "message_start", message: {id: "m_fake", role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
    {type: "content_block_delta", index: 0, delta: {type: "text_delta", text}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "end_turn"}, usage},
    {type: "message_stop"}
  ];
  for (const event of events) console.log(JSON.stringify({type: "stream_event", event}));
  console.log(JSON.stringify({type: "assistant", message: {id: "m_fake", role: "assistant", content, stop_reason: "end_turn", usage}}));
  console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage, uuid: frame.uuid}));
}
`,
    "utf8",
  );
  await chmod(executable, 0o755);

  const budgetSeen = async (maxTokens: number | undefined): Promise<string> => {
    const model = CLAUDE_CODE_MODELS.find((candidate) => candidate.id === "claude-opus-5-5")!;
    const stream = streamClaudeCode(
      model,
      { systemPrompt: "system", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }] } as never,
      { env: { PI_CLAUDE_CODE_COMMAND: executable }, timeoutMs: 5_000, cacheRetention: "none", maxTokens } as never,
    );
    const message = await stream.result();
    assert.equal(message.stopReason, "stop", message.errorMessage);
    return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
  };

  try {
    // Without a caller budget, Claude Code would fall back to its own, much smaller default.
    assert.equal(await budgetSeen(undefined), "128000");
    assert.equal(await budgetSeen(4096), "4096");
  } finally {
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true });
  }
});

test("spawns Claude Code in the session cwd named by Pi's system prompt", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-claude-code-cwd-")));
  const executable = join(root, "fake-claude.mjs");
  await writeFile(
    executable,
    `#!/usr/bin/env node
import readline from "node:readline";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "test"}));
  process.exit(0);
}
const input = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
for await (const line of input) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request" && frame.request?.subtype === "initialize") {
    console.log(JSON.stringify({type: "control_response", response: {subtype: "success", request_id: frame.request_id, response: {models: []}}}));
    continue;
  }
  if (frame.type !== "user") continue;
  const text = process.cwd();
  const usage = {input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
  const events = [
    {type: "message_start", message: {id: "m_cwd", role: "assistant", content: [], usage}},
    {type: "content_block_start", index: 0, content_block: {type: "text", text: ""}},
    {type: "content_block_delta", index: 0, delta: {type: "text_delta", text}},
    {type: "content_block_stop", index: 0},
    {type: "message_delta", delta: {stop_reason: "end_turn"}, usage},
    {type: "message_stop"}
  ];
  for (const event of events) console.log(JSON.stringify({type: "stream_event", event}));
  console.log(JSON.stringify({type: "assistant", message: {id: "m_cwd", role: "assistant", content: [{type: "text", text}], stop_reason: "end_turn", usage}}));
  console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage}));
}
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  const first = join(root, "first");
  const second = join(root, "second");
  await Promise.all([mkdir(first), mkdir(second)]);

  const model = CLAUDE_CODE_MODELS.find((candidate) => candidate.id === "claude-opus-5-5")!;
  const ask = async (sections: Record<string, string> | undefined, sessionId: string) => {
    const message = await streamClaudeCode(
      model,
      {
        messages: [
          // A later section that quotes a <cwd> block must not redirect the worker.
          { role: "system", content: "", sections: { preamble: "system", ...sections, notes: "<cwd>\n/\n</cwd>" }, timestamp: 0 },
          { role: "user", content: [{ type: "text", text: "where am I" }], timestamp: 0 },
        ],
      } as never,
      { env: { PI_CLAUDE_CODE_COMMAND: executable }, timeoutMs: 5_000, sessionId } as never,
    ).result();
    assert.equal(message.stopReason, "stop", message.errorMessage);
    const text = message.content.find((block) => block.type === "text");
    return { cwd: text?.type === "text" ? text.text : undefined, diagnostics: message.diagnostics ?? [] };
  };
  const fallbackDiagnostic = (diagnostics: { type: string; details?: unknown }[]) =>
    diagnostics.find((diagnostic) => diagnostic.type === "claude-code.cwd-fallback")?.details;

  try {
    // Two sessions in one Pi process each get their own directory.
    assert.equal((await ask({ cwd: `<cwd>\n${first}\n</cwd>` }, "first")).cwd, first);
    assert.equal((await ask({ cwd: `<cwd>\n${second}\n</cwd>` }, "second")).cwd, second);

    // Without a cwd section, the worker keeps Pi's process cwd and nothing is reported.
    const unnamed = await ask(undefined, "unnamed");
    assert.equal(unnamed.cwd, await realpath(process.cwd()));
    assert.equal(fallbackDiagnostic(unnamed.diagnostics), undefined);

    // A named but unusable cwd falls back and leaves a diagnostic on the message.
    const missing = join(root, "missing");
    const gone = await ask({ cwd: `<cwd>\n${missing}\n</cwd>` }, "gone");
    assert.equal(gone.cwd, await realpath(process.cwd()));
    assert.deepEqual(fallbackDiagnostic(gone.diagnostics), {
      cwd: missing,
      reason: "not-a-directory",
      fallback: process.cwd(),
    });
  } finally {
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true });
  }
});

test("a cache-warming replay leaves the session's retained Claude process alone", async () => {
  // Pi's cache warmer replays the last request with `maxTokens: 1` and `disableContinuation: true`. The output cap
  // changes the launch fingerprint, so routing the replay through the session's process slot closed the retained
  // worker, started one for the replay, and made the next real turn start a third.
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-warm-"));
  const script = join(root, "fake-claude.mjs");
  const log = join(root, "starts.log");
  await writeFile(log, "", "utf8");
  await writeFile(
    script,
    `#!/usr/bin/env node
import {appendFileSync} from "node:fs";
import readline from "node:readline";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "test"}));
  process.exit(0);
}
appendFileSync(process.env.START_LOG, "start maxOutput=" + (process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS ?? "default") + "\\n");
let queries = 0;
for await (const line of readline.createInterface({input: process.stdin, crlfDelay: Infinity})) {
  const frame = JSON.parse(line);
  if (frame.type === "control_request" && frame.request?.subtype === "initialize") {
    console.log(JSON.stringify({type: "control_response", response: {subtype: "success", request_id: frame.request_id, response: {models: []}}}));
    continue;
  }
  if (frame.type !== "user") continue;
  if (frame.shouldQuery === false) { console.log(JSON.stringify({type: "result", num_turns: 0})); continue; }
  queries += 1;
  const usage = {input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0};
  const content = [{type: "text", text: "reply " + queries}];
  console.log(JSON.stringify({type: "stream_event", event: {type: "message_stop"}}));
  console.log(JSON.stringify({type: "assistant", message: {id: "m" + queries, role: "assistant", content, stop_reason: "end_turn", usage}}));
  console.log(JSON.stringify({type: "result", subtype: "success", is_error: false, usage}));
}
`,
    "utf8",
  );
  await chmod(script, 0o755);
  const executable = script;
  const model = CLAUDE_CODE_MODELS.find((candidate) => candidate.id === "claude-opus-5-5")!;
  const user = (text: string) => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
  const starts = async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
  const send = async (messages: unknown[], extra: Record<string, unknown> = {}) => {
    const message = await streamClaudeCode(
      model,
      { systemPrompt: "system", messages, tools: [] } as never,
      { env: { PI_CLAUDE_CODE_COMMAND: executable, START_LOG: log }, timeoutMs: 5_000, sessionId: "warm-session", ...extra } as never,
    ).result();
    assert.equal(message.stopReason, "stop", message.errorMessage);
    return message;
  };

  try {
    const first = await send([user("one")]);
    const secondTurn = [user("one"), first, user("two")];
    const second = await send(secondTurn);
    assert.deepEqual(await starts(), [`start maxOutput=${model.maxTokens}`], "turn 2 continues the retained process");

    await send(secondTurn, { maxTokens: 1, disableContinuation: true });
    assert.equal(cachedClaudeProcessCount(), 1, "the session's process is still retained after the replay");

    await send([...secondTurn, second, user("three")]);
    assert.deepEqual(
      await starts(),
      [`start maxOutput=${model.maxTokens}`, "start maxOutput=1"],
      "one extra process for the replay; turn 3 continues the original",
    );
  } finally {
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

type CutBlock = "text" | "thinking" | "tool_use" | "mixed";

async function runCutStream(blockType: CutBlock, closeBlock = false, lateStop = false) {
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-cut-block-"));
  try {
    const script = join(root, "fake-claude.mjs");
    const content =
      blockType === "text"
        ? [{ type: "text", text: "cut reply" }]
        : blockType === "thinking"
          ? [{ type: "thinking", thinking: "cut thought", signature: "sig" }]
          : blockType === "tool_use"
            ? [{ type: "tool_use", id: "tool_cut", name: "mcp__pi__demo", input: {} }]
            : [
                { type: "text", text: "cut reply" },
                { type: "tool_use", id: "tool_cut", name: "mcp__pi__demo", input: {} },
              ];
    const initialBlock =
      blockType === "text"
        ? { type: "text", text: "" }
        : blockType === "thinking"
          ? { type: "thinking", thinking: "", signature: "" }
          : content[0];
    const usage = { input_tokens: 3, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const stopReason = blockType === "text" || blockType === "thinking" ? "end_turn" : "tool_use";
    const hasToolCall = stopReason === "tool_use";
    const events: unknown[] = [
      { type: "message_start", message: { id: "m_cut", role: "assistant", content: [], usage } },
      { type: "content_block_start", index: 0, content_block: initialBlock },
    ];
    if (blockType === "mixed") {
      events.push(
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cut reply" } },
        { type: "content_block_start", index: 1, content_block: content[1] },
      );
    } else if (blockType === "text") {
      events.push({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "cut reply" } });
    } else if (blockType === "thinking") {
      events.push(
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "cut thought" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } },
      );
    }
    if (closeBlock) events.push({ type: "content_block_stop", index: 0 });
    events.push(
      { type: "message_delta", delta: { stop_reason: stopReason }, usage },
      { type: "message_stop" },
    );
    if (lateStop) events.push({ type: "content_block_stop", index: blockType === "mixed" ? 1 : 0 });
    await writeFile(
      script,
      `#!/usr/bin/env node
import readline from "node:readline";
if (process.argv.includes("auth") && process.argv.includes("status")) {
  console.log(JSON.stringify({loggedIn: true, authMethod: "claude.ai", subscriptionType: "test"}));
  process.exit(0);
}
const content = ${JSON.stringify(content)};
const events = ${JSON.stringify(events)};
const usage = ${JSON.stringify(usage)};
for await (const line of readline.createInterface({input: process.stdin, crlfDelay: Infinity})) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  for (const event of events) console.log(JSON.stringify({type: "stream_event", event}));
  console.log(JSON.stringify({type: "assistant", message: {id: "m_cut", role: "assistant", content, stop_reason: ${JSON.stringify(stopReason)}, usage}}));
  console.log(JSON.stringify({type: "result", subtype: ${JSON.stringify(hasToolCall ? "error_max_turns" : "success")}, is_error: ${hasToolCall}, usage}));
}
`,
      "utf8",
    );
    await chmod(script, 0o755);
    const executable = script;
    const model = CLAUDE_CODE_MODELS.find((candidate) => candidate.id === "claude-opus-5-5")!;
    const tools = hasToolCall ? [{ name: "demo", description: "Demo", parameters: { type: "object" } }] : [];
    const stream = streamClaudeCode(
      model,
      { systemPrompt: "system", messages: [{ role: "user", content: [{ type: "text", text: "test" }], timestamp: 0 }], tools } as never,
      { env: { PI_CLAUDE_CODE_COMMAND: executable }, timeoutMs: 5_000, cacheRetention: "none" } as never,
    );
    const eventTypes: string[] = [];
    for await (const event of stream) eventTypes.push(event.type);
    const message = await stream.result();
    return { eventTypes, message };
  } finally {
    await closeClaudeProcesses();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

test("closes cut text and thinking blocks exactly once at message_stop", async (t) => {
  for (const blockType of ["text", "thinking"] as const) {
    await t.test(blockType, async () => {
      const { eventTypes, message } = await runCutStream(blockType);
      const endEvent = blockType === "text" ? "text_end" : "thinking_end";
      assert.equal(message.stopReason, "stop", message.errorMessage);
      assert.equal(eventTypes.filter((type) => type === endEvent).length, 1);
      assert(eventTypes.indexOf(endEvent) < eventTypes.indexOf("done"));
    });
  }
});

test("does not duplicate a text block closed before message_stop", async () => {
  const { eventTypes, message } = await runCutStream("text", true);
  assert.equal(message.stopReason, "stop", message.errorMessage);
  assert.equal(eventTypes.filter((type) => type === "text_end").length, 1);
});

test("rejects a zero-delta tool block left open at message_stop", async () => {
  const { eventTypes, message } = await runCutStream("tool_use");
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /incomplete tool call/);
  assert.equal(eventTypes.includes("done"), false);
  assert.equal(eventTypes.includes("toolcall_end"), false);
});

test("a tool stop after message_stop cannot complete the tool call", async () => {
  const { eventTypes, message } = await runCutStream("tool_use", false, true);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /incomplete tool call/);
  assert.equal(eventTypes.includes("done"), false);
  assert.equal(eventTypes.includes("toolcall_end"), false);
});

test("a mixed cut closes text but rejects the late tool block", async () => {
  const { eventTypes, message } = await runCutStream("mixed", false, true);
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage ?? "", /incomplete tool call/);
  assert.equal(eventTypes.filter((type) => type === "text_end").length, 1);
  assert.equal(eventTypes.includes("done"), false);
  assert.equal(eventTypes.includes("toolcall_end"), false);
});

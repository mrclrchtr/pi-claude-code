import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import test from "node:test";
import { AnthropicCapture, describeFailure, TurnRelay } from "../src/turn-relay.ts";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing address");
      resolve(address.port);
    });
  });
}

test("relays one upstream Messages request and captures its SSE response", async () => {
  const upstreamBodies: string[] = [];
  const upstreamBetas: string[] = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    upstreamBodies.push(body);
    upstreamBetas.push(String(request.headers["anthropic-beta"] ?? ""));
    response.writeHead(200, { "content-type": "text/event-stream", "request-id": "req_test" });
    const usage = {
      input_tokens: 2,
      output_tokens: 1,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    };
    const events = [
      { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
      { type: "message_stop" },
    ];
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  const upstreamPort = await listen(upstream);
  const observed: string[] = [];
  const relay = new TurnRelay(
    `http://127.0.0.1:${upstreamPort}`,
    5_000,
    (event) => observed.push(event.type),
    (body) => Buffer.from(JSON.stringify({ ...JSON.parse(body.toString("utf8")), rewritten: true })),
    ["native-tools-test"],
  );

  try {
    const baseUrl = await relay.start();
    const first = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "anthropic-beta": "existing-test" },
      body: "{}",
    });
    assert.equal(first.status, 200);
    await first.text();
    const second = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(second.status, 400);
    await relay.settled();

    assert.equal(upstreamBodies.length, 1);
    assert.deepEqual(JSON.parse(upstreamBodies[0]!), { rewritten: true });
    assert.deepEqual(JSON.parse(relay.originalRequestBody!.toString("utf8")), {});
    assert.equal(upstreamBetas[0], "existing-test,native-tools-test");
    assert.equal(relay.used, true);
    assert.equal(relay.denied, 1);
    assert.equal(relay.capture.complete, true);
    assert.equal(relay.capture.message?.content[0]?.type, "text");
    assert.equal((relay.capture.message?.content[0] as { text: string }).text, "hello");
    assert.equal(relay.requestId, "req_test");
    assert.deepEqual(observed.at(-1), "message_stop");

    relay.finishTurn();
    const nextObserved: string[] = [];
    relay.beginTurn((event) => nextObserved.push(event.type));
    const next = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: '{"turn":2}' });
    assert.equal(next.status, 200);
    await next.text();
    await relay.settled();
    assert.equal(upstreamBodies.length, 2);
    assert.deepEqual(JSON.parse(upstreamBodies[1]!), { turn: 2 });
    assert.equal(relay.denied, 0);
    assert.equal(relay.capture.complete, true);
    assert.equal(nextObserved.at(-1), "message_stop");
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("adds the per-message effort beta when the forwarded body carries a system message with output_config", async () => {
  // Claude Code sends a `role: "system"` message with `output_config.effort` under its own
  // per-turn beta. When the relay replays that message on a request whose header lacks a beta
  // that admits it, Anthropic rejects it: `messages.1.output_config: Extra inputs are not permitted`.
  // https://platform.claude.com/docs/en/build-with-claude/effort-per-message
  const betas: string[] = [];
  const upstream = http.createServer(async (request, response) => {
    for await (const _ of request);
    betas.push(String(request.headers["anthropic-beta"] ?? ""));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  });
  const port = await listen(upstream);
  const relay = new TurnRelay(`http://127.0.0.1:${port}`, 5_000);
  const effortSystem = { role: "system", content: [], output_config: { effort: "medium" } };
  try {
    const baseUrl = await relay.start();
    for (const [messages, header] of [
      [[{ role: "user", content: "hi" }, effortSystem], "claude-code-20250219"],
      [[{ role: "user", content: "hi" }], "claude-code-20250219"],
      [[{ role: "user", content: "hi" }, effortSystem], "claude-code-20250219,mid-conversation-output-config-2026-07-01"],
    ] as const) {
      relay.beginTurn();
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "anthropic-beta": header },
        body: JSON.stringify({ messages }),
      });
      await response.text();
      await relay.settled();
      relay.finishTurn();
    }
    assert.deepEqual(betas, [
      "claude-code-20250219,mid-conversation-output-config-2026-07-01",
      "claude-code-20250219",
      "claude-code-20250219,mid-conversation-output-config-2026-07-01",
    ]);
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("detects per-message effort in the forwarded body and merges beta headers", async (t) => {
  const beta = "mid-conversation-output-config-2026-07-01";
  const effortSystem = { role: "system", content: [], output_config: { effort: "medium" } };
  const plain = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
  const effort = JSON.stringify({ messages: [{ role: "user", content: "hi" }, effortSystem] });
  const cases: {
    name: string;
    body: string;
    forwarded?: string;
    header?: string;
    requestBetas?: string[];
    expected: string;
  }[] = [
    { name: "no incoming header", body: effort, expected: beta },
    {
      name: "merge and deduplicate incoming and requested betas",
      body: effort,
      header: ` existing-test, ${beta},existing-test `,
      requestBetas: ["native-tools-test", beta, "existing-test"],
      expected: `existing-test,${beta},native-tools-test`,
    },
    { name: "transform adds effort", body: plain, forwarded: effort, expected: beta },
    { name: "transform removes effort", body: effort, forwarded: plain, expected: "" },
    { name: "top-level only", body: JSON.stringify({ output_config: { effort: "high" }, messages: [] }), expected: "" },
    { name: "user field", body: JSON.stringify({ messages: [{ ...effortSystem, role: "user" }] }), expected: "" },
    { name: "assistant field", body: JSON.stringify({ messages: [{ ...effortSystem, role: "assistant" }] }), expected: "" },
    { name: "system without field", body: JSON.stringify({ messages: [{ role: "system", content: [] }] }), expected: "" },
    { name: "nested tool argument", body: JSON.stringify({ messages: [{ role: "assistant", content: [{ type: "tool_use", input: effortSystem }] }] }), expected: "" },
    { name: "absent messages", body: "{}", expected: "" },
    { name: "null messages", body: '{"messages":null}', expected: "" },
    { name: "non-array messages", body: '{"messages":{}}', expected: "" },
    { name: "non-object messages", body: '{"messages":[null,1,"system",[]]}', expected: "" },
    { name: "null payload", body: "null", expected: "" },
    { name: "malformed JSON", body: "{", expected: "" },
    { name: "empty body", body: "", expected: "" },
    { name: "no effort preserves existing header", body: plain, header: "existing-test", expected: "existing-test" },
  ];
  const seen: { body: string; beta: string }[] = [];
  const upstream = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    seen.push({ body, beta: String(request.headers["anthropic-beta"] ?? "") });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  });
  const port = await listen(upstream);
  const relay = new TurnRelay(`http://127.0.0.1:${port}`, 5_000);
  try {
    const baseUrl = await relay.start();
    for (const entry of cases) {
      await t.test(entry.name, async () => {
        relay.beginTurn(undefined, entry.forwarded === undefined ? undefined : () => Buffer.from(entry.forwarded!), entry.requestBetas);
        const response = await fetch(`${baseUrl}/v1/messages`, {
          method: "POST",
          headers: entry.header === undefined ? {} : { "anthropic-beta": entry.header },
          body: entry.body,
        });
        assert.equal(response.status, 200);
        await response.text();
        await relay.settled();
        assert.deepEqual(seen.at(-1), { body: entry.forwarded ?? entry.body, beta: entry.expected });
        assert.equal(relay.originalRequestBody?.toString("utf8"), entry.body);
        relay.finishTurn();
      });
    }
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("surfaces an error event from an otherwise successful SSE stream", async () => {
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const usage = { input_tokens: 2, output_tokens: 0 };
    response.end(
      [
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } })}\n\n`,
        `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`,
      ].join(""),
    );
  });
  const upstreamPort = await listen(upstream);
  const relay = new TurnRelay(`http://127.0.0.1:${upstreamPort}`, 5_000);

  try {
    const baseUrl = await relay.start();
    const response = await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" });
    assert.equal(response.status, 200);
    await response.text();
    await relay.settled();

    assert.equal(relay.capture.complete, false);
    assert.equal(relay.errorText(), "overloaded_error: Overloaded");
  } finally {
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("does not complete a zero-delta tool block at message_stop", () => {
  const usage = { input_tokens: 2, output_tokens: 1 };
  const events = [
    { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool1", name: "demo", input: {} } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage },
    { type: "message_stop" },
  ];
  const capture = new AnthropicCapture();
  capture.feed(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
  capture.finish();
  assert.equal(capture.complete, false);
});

test("captures a normally closed tool call", () => {
  const usage = { input_tokens: 2, output_tokens: 1 };
  const events = [
    { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool1", name: "demo", input: {} } },
    { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"query":"*"}' } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage },
    { type: "message_stop" },
  ];
  const capture = new AnthropicCapture();
  capture.feed(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
  capture.finish();
  assert.equal(capture.complete, true);
  assert.equal(capture.incompleteToolCall, false);
  assert.deepEqual(capture.message?.content[0], { type: "tool_use", id: "tool1", name: "demo", input: { query: "*" } });
});

test("a late tool stop cannot complete a cut tool call", () => {
  const usage = { input_tokens: 2, output_tokens: 1 };
  const events = [
    { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "tool1", name: "demo", input: {} } },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage },
    { type: "message_stop" },
    { type: "content_block_stop", index: 0 },
    { type: "message_stop" },
  ];
  const capture = new AnthropicCapture();
  capture.feed(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
  capture.finish();
  assert.equal(capture.complete, false);
  assert.equal(capture.incompleteToolCall, true);
});

test("describes relay failures with their error code and nested errors", () => {
  const refused = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
  assert.equal(describeFailure(refused), "Error: connect ECONNREFUSED 127.0.0.1:1");
  const timeout = Object.assign(new Error("connect ETIMEDOUT 10.0.0.1:443"), { code: "ETIMEDOUT" });
  const every = Object.assign(new AggregateError([refused, timeout]), { code: "ETIMEDOUT" });
  assert.equal(
    describeFailure(every),
    "AggregateError (ETIMEDOUT) [Error: connect ECONNREFUSED 127.0.0.1:1; Error: connect ETIMEDOUT 10.0.0.1:443]",
  );
  assert.equal(describeFailure(Object.assign(new Error(""), { code: "ECONNRESET" })), "Error (ECONNRESET)");
  assert.equal(describeFailure("nope"), "UnknownError");
});

test("gives each upstream address at least 5 s to connect, keeping a larger Node default", async () => {
  const defaultAttemptTimeout = net.getDefaultAutoSelectFamilyAttemptTimeout();
  // Spy on the shared agent's socket factory: module namespace bindings are not patchable under every TS loader.
  type CreateConnection = (options: net.NetConnectOpts, callback?: () => void) => net.Socket;
  const agent = http.globalAgent as unknown as { createConnection: CreateConnection };
  const seen: unknown[] = [];
  agent.createConnection = (options, callback) => {
    seen.push((options as net.TcpNetConnectOpts).autoSelectFamilyAttemptTimeout);
    return net.createConnection(options, callback);
  };
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request);
    // Close the socket so each request connects again and reaches the spy.
    response.writeHead(500, { connection: "close" }).end();
  });
  const upstreamPort = await listen(upstream);
  const relay = new TurnRelay(`http://127.0.0.1:${upstreamPort}`, 5_000);
  try {
    const baseUrl = await relay.start();
    await (await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" })).text();
    await relay.settled();
    assert.equal(seen[0], 5_000);

    net.setDefaultAutoSelectFamilyAttemptTimeout(10_000);
    relay.finishTurn();
    relay.beginTurn();
    await (await fetch(`${baseUrl}/v1/messages`, { method: "POST", body: "{}" })).text();
    await relay.settled();
    assert.equal(seen[1], 10_000);
  } finally {
    net.setDefaultAutoSelectFamilyAttemptTimeout(defaultAttemptTimeout);
    delete (agent as Partial<typeof agent>).createConnection;
    await relay.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test("dumps each request without credentials only when a debug directory is set", async () => {
  const { mkdtemp, readdir, readFile, rm, stat } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const upstream = http.createServer(async (request, response) => {
    for await (const _chunk of request);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const usage = { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: 7 };
    const events = [
      { type: "message_start", message: { id: "m1", role: "assistant", content: [], usage } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage },
      { type: "message_stop" },
    ];
    response.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  });
  const port = await listen(upstream);
  const root = await mkdtemp(join(tmpdir(), "pi-claude-code-debug-"));
  const directory = join(root, "dumps");
  const send = async (relay: TurnRelay) => {
    const baseUrl = await relay.start();
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { authorization: "Bearer secret", "x-api-key": "secret", "anthropic-beta": "kept" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    await response.text();
    await relay.settled();
    await relay.close();
  };

  try {
    await send(new TurnRelay(`http://127.0.0.1:${port}`, 5_000, undefined, undefined, [], ""));
    await assert.rejects(readdir(directory));

    await send(
      new TurnRelay(
        `http://127.0.0.1:${port}`,
        5_000,
        undefined,
        (body) => Buffer.from(JSON.stringify({ ...JSON.parse(body.toString("utf8")), rewritten: true })),
        [],
        directory,
      ),
    );
    const files = await readdir(directory);
    assert.equal(files.length, 1);
    assert.equal((await stat(join(directory, files[0]!))).mode & 0o777, 0o600);
    const dump = JSON.parse(await readFile(join(directory, files[0]!), "utf8"));
    assert.deepEqual(dump.original, { messages: [{ role: "user", content: "hi" }] });
    assert.equal(dump.sent.rewritten, true);
    assert.equal(dump.usage.cache_read_input_tokens, 7);
    assert.equal(dump.headers["anthropic-beta"], "kept");
    assert.doesNotMatch(JSON.stringify(dump), /secret/u);
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

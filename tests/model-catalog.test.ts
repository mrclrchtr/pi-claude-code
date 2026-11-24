import assert from "node:assert/strict";
import test from "node:test";
import {
  CLAUDE_CODE_MODELS,
  modelFromDiscovery,
  nativeModel,
  supportsDisabledThinking,
  supportsNativeToolChanges,
} from "../src/model-catalog.ts";

test("fallback catalog matches Claude Code's selectable model families", () => {
  assert.deepEqual(
    CLAUDE_CODE_MODELS.map((model) => model.id),
    [
      "default",
      "claude-opus-5-5",
      "claude-fable-5-1",
      "claude-sonnet-5",
      "claude-haiku-4-5-20251001",
    ],
  );
  assert.equal(nativeModel("default"), "default");
  assert.equal(nativeModel("claude-opus-5-5"), "opus[1m]");
  assert.equal(nativeModel("claude-sonnet-5"), "sonnet");
  assert.equal(supportsNativeToolChanges("default"), true);
  assert.equal(supportsNativeToolChanges("claude-opus-5-5"), true);
  assert.equal(supportsNativeToolChanges("claude-fable-5-1"), true);
  assert.equal(supportsNativeToolChanges("claude-sonnet-5"), false);
});

test("maps discovered aliases to stable canonical Pi model ids", () => {
  const opus = modelFromDiscovery({
    value: "opus[1m]",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Opus (1M context)",
    description: "Opus 5.5 with 1M context",
    supportsEffort: true,
    supportedEffortLevels: ["low", "high", "max"],
    supportsAdaptiveThinking: true,
  });
  assert.equal(opus.id, "claude-opus-5-5");
  assert.equal(opus.name, "Claude Opus 5.5");
  assert.equal(opus.contextWindow, 1_000_000);
  assert.deepEqual(opus.cost, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.deepEqual(opus.thinkingLevelMap, {
    off: null,
    minimal: null,
    low: "low",
    medium: "medium",
    high: "high",
    xhigh: "xhigh",
    max: "max",
  });

  const future = modelFromDiscovery({
    value: "future",
    resolvedModel: "claude-future-1",
    displayName: "Future",
    description: "A newly available model",
  });
  assert.equal(future.id, "claude-future-1");
  assert.equal(future.cost.input, 0);
  // No built-in model of that family: keep the conservative defaults.
  assert.equal(future.contextWindow, 200_000);
  assert.equal(future.maxTokens, 64_000);
});

test("gives a model newer than Pi's catalog its predecessor's context window and output limit", () => {
  // Claude Code served Fable 5.2 as `fable` before Pi listed it, with no "1M context" description.
  const fable = modelFromDiscovery({
    value: "fable",
    resolvedModel: "claude-fable-5-99",
    displayName: "Fable 5.99",
    description: "For your toughest challenges",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
  });
  assert.equal(fable.id, "claude-fable-5-99");
  assert.equal(fable.contextWindow, 1_000_000);
  assert.equal(fable.maxTokens, 128_000);
  // Pricing is not inferred: an unlisted model may be priced differently.
  assert.equal(fable.cost.input, 0);

  // Only older releases count as predecessors, and dated snapshots are never family heads.
  const ancient = modelFromDiscovery({
    value: "claude-sonnet-4-1",
    resolvedModel: "claude-sonnet-4-1",
    displayName: "Sonnet 4.1",
    description: "Older",
  });
  assert.equal(ancient.contextWindow, 200_000);
  assert.equal(ancient.maxTokens, 64_000);
  const dated = modelFromDiscovery({
    value: "claude-haiku-4-6-20260101",
    resolvedModel: "claude-haiku-4-6-20260101",
    displayName: "Haiku snapshot",
    description: "Dated",
  });
  assert.equal(dated.contextWindow, 200_000);
});

test("Pi's catalog decides whether thinking can be disabled; Claude Code's answer covers unlisted models", () => {
  // Claude Code reports Haiku 5.5 as unable to disable thinking, but Pi's catalog and the API accept it.
  const haiku = {
    value: "haiku",
    resolvedModel: "claude-haiku-5-5",
    displayName: "Haiku 5.5",
    description: "Fastest for quick answers",
    supportsAdaptiveThinking: true,
    supportsThinkingOff: false,
  };
  modelFromDiscovery(haiku);
  assert.equal(supportsDisabledThinking("claude-haiku-5-5"), true);

  const unlisted = {
    value: "claude-future-9",
    resolvedModel: "claude-future-9",
    displayName: "Future 9",
    description: "Not in Pi's catalog",
    supportsAdaptiveThinking: true,
  };
  modelFromDiscovery(unlisted);
  assert.equal(supportsDisabledThinking("claude-future-9"), false, "an unlisted adaptive model is assumed newer");
  modelFromDiscovery({ ...unlisted, supportsThinkingOff: true });
  assert.equal(supportsDisabledThinking("claude-future-9"), true);
});

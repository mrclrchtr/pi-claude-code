import type { Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

export const PROVIDER_ID = "claude-code";
export const API_ID = "claude-code-stream-json";

export type ClaudeCodeModel = Model<typeof API_ID> & {
  /**
   * The Claude Code catalog row this model came from. Pi persists discovered models and restores
   * them without calling the provider, so the row travels with the model to rebuild its route and
   * thinking support after a reload.
   */
  claudeCode?: DiscoveredClaudeModel;
};

export interface DiscoveredClaudeModel {
  value: string;
  resolvedModel?: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: Array<"low" | "medium" | "high" | "xhigh" | "max">;
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
  /** Reported by newer Claude Code versions: whether `thinking: { type: "disabled" }` is accepted. */
  supportsThinkingOff?: boolean;
}

// Pi exposes providers/all to extensions, but not individual generated model files.
const BUILTIN_ANTHROPIC_MODELS: Record<string, Model<"anthropic-messages">> = Object.fromEntries(
  getBuiltinModels("anthropic").map((model) => [model.id, model]),
);
const NATIVE_ROUTE_BY_ID = new Map<string, string>();
const NATIVE_TOOL_CHANGES_BY_ID = new Map<string, boolean>();
const ADAPTIVE_THINKING_BY_ID = new Map<string, boolean>();
const DISABLED_THINKING_BY_ID = new Map<string, boolean>();

const FALLBACK_DISCOVERY: DiscoveredClaudeModel[] = [
  {
    value: "default",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Default (recommended)",
    description: "Opus 5.5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "opus[1m]",
    resolvedModel: "claude-opus-5-5[1m]",
    displayName: "Opus (1M context)",
    description: "Opus 5.5 with 1M context · Best for everyday, complex tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsFastMode: true,
    supportsAutoMode: true,
  },
  {
    value: "claude-fable-5-1[1m]",
    resolvedModel: "claude-fable-5-1",
    displayName: "Fable",
    description: "Fable 5.1 · Most capable for the hardest and longest-running tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "sonnet",
    resolvedModel: "claude-sonnet-5",
    displayName: "Sonnet",
    description: "Sonnet 5 · Efficient for routine tasks",
    supportsEffort: true,
    supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    supportsAdaptiveThinking: true,
    supportsAutoMode: true,
  },
  {
    value: "haiku",
    resolvedModel: "claude-haiku-4-5-20251001",
    displayName: "Haiku",
    description: "Haiku 4.5 · Fastest for quick answers",
  },
];

const ALIASES: Record<string, string> = {
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
  "claude-haiku-4-5": "claude-haiku-4-5-20251001",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1",
};

function withoutContextSuffix(model: string): string {
  return model.replace(/\[1m\]$/u, "");
}

function canonicalModelId(info: DiscoveredClaudeModel): string {
  if (info.value === "default") return "default";
  return withoutContextSuffix(info.resolvedModel || ALIASES[withoutContextSuffix(info.value)] || info.value);
}

const MODEL_VERSION = /^(claude-[a-z]+)-(\d+(?:-\d+)*)$/u;

/** Version parts of an undated model id such as `claude-fable-5-1`; dated snapshots are not family heads. */
function modelVersion(id: string): { family: string; parts: number[] } | undefined {
  const match = MODEL_VERSION.exec(id);
  if (!match) return undefined;
  const parts = match[2].split("-").map(Number);
  return parts.some((part) => part > 999) ? undefined : { family: match[1], parts };
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * The newest built-in model of the same family released before `id`. Claude Code serves models
 * before Pi's bundled catalog lists them (Fable 5.2 arrived as an unknown id), and its discovery
 * rows carry no context window or output limit. A successor keeps its predecessor's limits far more
 * often than it falls back to 200K, so the predecessor's limits are the better guess.
 */
function predecessorModel(id: string): Model<"anthropic-messages"> | undefined {
  const target = modelVersion(id);
  if (!target) return undefined;
  let best: { model: Model<"anthropic-messages">; parts: number[] } | undefined;
  for (const model of Object.values(BUILTIN_ANTHROPIC_MODELS)) {
    const candidate = modelVersion(model.id);
    if (!candidate || candidate.family !== target.family) continue;
    if (compareVersions(candidate.parts, target.parts) >= 0) continue;
    if (!best || compareVersions(candidate.parts, best.parts) > 0) best = { model, parts: candidate.parts };
  }
  return best?.model;
}

function fallbackModel(info: DiscoveredClaudeModel, id: string): ClaudeCodeModel {
  const supported = info.supportedEffortLevels;
  const thinkingLevelMap = supported?.length
    ? (Object.fromEntries(supported.map((level) => [level, level])) as ClaudeCodeModel["thinkingLevelMap"])
    : undefined;
  const predecessor = predecessorModel(id);
  const longContext = /\b1M context\b/iu.test(info.description) || info.value.endsWith("[1m]");
  return {
    id,
    name: `${info.displayName} (Claude Code)`,
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: "process://claude-code",
    reasoning: info.supportsAdaptiveThinking === true || info.supportsEffort === true,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: ["text", "image"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: longContext ? 1_000_000 : (predecessor?.contextWindow ?? 200_000),
    maxTokens: predecessor?.maxTokens ?? 64_000,
  };
}

function fromBuiltin(info: DiscoveredClaudeModel, id: string, builtin: Model<"anthropic-messages">): ClaudeCodeModel {
  const {
    api: _api,
    provider: _provider,
    baseUrl: _baseUrl,
    compat: _compat,
    ...metadata
  } = builtin;
  return {
    ...metadata,
    id,
    name: id === "default" ? `Default (${builtin.name})` : builtin.name,
    api: API_ID,
    provider: PROVIDER_ID,
    baseUrl: "process://claude-code",
  };
}

/** Convert a Claude Code catalog row into Pi's built-in Anthropic naming and pricing. */
export function modelFromDiscovery(info: DiscoveredClaudeModel): ClaudeCodeModel {
  const { id, builtin } = registerDiscoveredModel(info);
  const model = builtin ? fromBuiltin(info, id, builtin) : fallbackModel(info, id);
  return { ...model, claudeCode: { ...info } };
}

/**
 * Rebuild the route and thinking support from the catalog row a model carries. Models restored
 * from Pi's store skip modelFromDiscovery, so without this they would use the fallback routes.
 */
export function registerModel(model: Model<any>): void {
  const info = (model as ClaudeCodeModel).claudeCode;
  if (info && canonicalModelId(info) === model.id) registerDiscoveredModel(info);
}

function registerDiscoveredModel(info: DiscoveredClaudeModel): {
  id: string;
  builtin?: Model<"anthropic-messages">;
} {
  const id = canonicalModelId(info);
  const builtinId = id === "default" ? withoutContextSuffix(info.resolvedModel || "") : id;
  const builtin = BUILTIN_ANTHROPIC_MODELS[builtinId];
  NATIVE_ROUTE_BY_ID.set(id, info.value);
  NATIVE_TOOL_CHANGES_BY_ID.set(id, builtin?.compat?.supportsMidConvoToolChanges === true);
  ADAPTIVE_THINKING_BY_ID.set(id, info.supportsAdaptiveThinking === true);
  DISABLED_THINKING_BY_ID.set(
    id,
    // Pi marks models that reject `thinking.type: disabled` with `off: null`, and its catalog
    // is maintained, so it wins for known models: Claude Code reports Haiku 5.5 as unable to
    // disable thinking although the API accepts it. For a model Pi does not list yet, Claude
    // Code's own answer is better than assuming that a newer adaptive model cannot disable it.
    builtin
      ? builtin.thinkingLevelMap?.off !== null
      : (info.supportsThinkingOff ?? info.supportsAdaptiveThinking !== true),
  );
  return { id, builtin };
}

export const CLAUDE_CODE_MODELS: ClaudeCodeModel[] = FALLBACK_DISCOVERY.map(modelFromDiscovery);

export function nativeModel(model: string): string {
  const direct = NATIVE_ROUTE_BY_ID.get(model);
  if (direct) return direct;
  if (model === "default") return model;
  const canonical = canonicalRoute(model);
  return model.endsWith("[1m]") ? `${canonical}[1m]` : canonical;
}

function canonicalRoute(model: string): string {
  const withoutSuffix = withoutContextSuffix(model);
  return ALIASES[withoutSuffix] ?? withoutSuffix;
}

/** Whether Claude Code reports adaptive thinking for this model. Unknown models are assumed to support it. */
export function supportsAdaptiveThinking(model: string): boolean {
  const canonical = canonicalRoute(model);
  return ADAPTIVE_THINKING_BY_ID.get(model) ?? ADAPTIVE_THINKING_BY_ID.get(canonical) ?? true;
}

/** Whether the API accepts `thinking: { type: "disabled" }` for this model. */
export function supportsDisabledThinking(model: string): boolean {
  const canonical = canonicalRoute(model);
  const known = DISABLED_THINKING_BY_ID.get(model) ?? DISABLED_THINKING_BY_ID.get(canonical);
  if (known !== undefined) return known;
  const builtin = BUILTIN_ANTHROPIC_MODELS[canonical];
  return builtin ? builtin.thinkingLevelMap?.off !== null : !supportsAdaptiveThinking(model);
}

/** Whether Anthropic currently accepts native mid-conversation tool blocks for this route. */
export function supportsNativeToolChanges(model: string): boolean {
  const canonical = canonicalRoute(model);
  return (
    NATIVE_TOOL_CHANGES_BY_ID.get(model) ??
    NATIVE_TOOL_CHANGES_BY_ID.get(canonical) ??
    BUILTIN_ANTHROPIC_MODELS[canonical]?.compat?.supportsMidConvoToolChanges === true
  );
}

export function modelForDiscoveredRoute(route: string, label?: string): ClaudeCodeModel | undefined {
  const canonical = withoutContextSuffix(ALIASES[withoutContextSuffix(route)] ?? route);
  const known = CLAUDE_CODE_MODELS.find((model) => model.id === canonical);
  return known ? { ...known, name: label ? `${label} (Claude Code)` : known.name } : undefined;
}

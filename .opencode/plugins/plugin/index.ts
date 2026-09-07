import type { Plugin, PluginInput } from '@opencode-ai/plugin'
import {
  autoDetectLLMRouter,
  checkLLMRouterHealth,
  discoverLLMRouterModelInfo,
  discoverLLMRouterModels,
  normalizeBaseURL,
} from '../utils/llmrouter-api'
import {
  formatModelName,
  categorizeModel,
} from '../utils/format-model-name'
import type { LLMRouterModel, LLMRouterModelInfo } from '../types'
import { getOpenCodeStoredApiKey } from '../utils/opencode-auth'
import { readModelCache, writeModelCache, readModelCacheSavedAt } from '../utils/model-cache'

const CHAT_PROVIDER_ID = 'llmrouter'
// Covers the sequential 3 s health check plus the parallel 15 s
// models/model-info fetch phase, with headroom.
const DISCOVERY_TIMEOUT_MS = 2000
// Don't revalidate a baseURL's cache more often than this, so a burst
// of `session.created` events can't generate repeated discovery traffic.
const REFRESH_MIN_INTERVAL_MS = 1000 // 5 minutes

/**
 * OpenCode invokes the `config` hook several times per run with a
 * cumulative config object. Track which model ids we already injected
 * per provider (keyed by `providerId@baseURL`) so repeat invocations
 * can return early instead of re-querying the proxy.
 */
const injectedModelIds = new Map<string, Set<string>>()

/**
 * Per-provider fetch context captured during the `config` hook, so the
 * `event` hook can revalidate the cache in the background (SWR) without
 * re-deriving auth/headers. Keyed by `providerId@baseURL` — the same
 * key as the on-disk cache — so providers sharing a proxy keep
 * independent refresh contexts.
 */
interface RefreshContext {
  baseURL: string
  modelUrl: string
  apiKey?: string
  customHeaders?: Record<string, string>
  providerId: string
}
const refreshContexts = new Map<string, RefreshContext>()

/** Cache keys with an in-flight background refresh, to avoid pile-ups. */
const refreshInFlight = new Set<string>()

/**
 * Race a promise against a timeout, resolving to `null` if the timeout
 * wins. Clears the timer either way so a resolved discovery can't keep
 * a short-lived process alive waiting on a pending `setTimeout`.
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * Helper to determine if a provider ID or its configured options indicate
 * compatibility with LLMRouter.
 */
function isLLMRouterProvider(
  providerId: string,
  options: Record<string, unknown>,
): boolean {
  if (providerId === CHAT_PROVIDER_ID) return true
  if (providerId.startsWith('llmrouter-') || providerId.startsWith('llmrouter_')) return true
  return false
}

/**
 * Read `customHeaders` from a provider options block.
 */
function readCustomHeaders(
  options: Record<string, unknown>,
): Record<string, string> | undefined {
  const raw = options.customHeaders
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v
    }
    return Object.keys(out).length > 0 ? out : undefined
  }
  return undefined
}

/**
 * Overlay metadata from `/v1/model/info` onto a `/v1/models` entry.
 * Fields already present on the lean entry win; the info block only
 * fills gaps (notably `mode`, which `/v1/models` omits for
 * database-defined models).
 */
function enrichModel(model: LLMRouterModel, info: LLMRouterModelInfo): LLMRouterModel {
  return {
    ...model,
    mode: model.mode,
    max_tokens: model.max_tokens ?? info.maxInputTokens + info.maxOutputTokens,
    max_input_tokens: model.max_input_tokens ?? info.maxInputTokens,
    max_output_tokens: model.max_output_tokens ?? info.maxOutputTokens,
    supports_function_calling: model.supports_function_calling,
    supports_vision: model.supports_vision ?? info.modalities?.includes('Vision'),
    supports_reasoning: model.supports_reasoning ?? info.supportsReasoning,
    supports_pdf_input: model.supports_pdf_input ?? info.modalities?.includes('Vision'),
    supports_audio_input: model.supports_audio_input,
    input_cost_per_token: model.input_cost_per_token ?? info.inputCostPerToken,
    output_cost_per_token: model.output_cost_per_token ?? info.outputCostPerToken,
    cache_read_input_token_cost: model.cache_read_input_token_cost ?? info.cacheReadInputTokenCost,
    cache_creation_input_token_cost:
      model.cache_creation_input_token_cost,
  }
}

/**
 * OpenCode's `cost` config field is USD per **million** tokens (the
 * models.dev convention); LLMRouter's `/v1/model/info` reports USD per
 * single token. `1e6` bridges the two — verified against a live
 * `x-llmrouter-response-cost` header, not just the unit names.
 */
const PRICE_PER_TOKEN_TO_PER_MILLION = 1_000_000

/**
 * Convert a discovered LLMRouter model into an OpenCode config-level
 * model entry (the shape used in `provider.*.models` inside
 * `opencode.json`). Returns `null` for non-chat models (embedding,
 * image, audio) — they can't be used as primary chat models and would
 * clutter the picker.
 */
function toConfigModel(
  model: LLMRouterModel,
  info?: LLMRouterModelInfo,
): Record<string, unknown> | null {
  const type = categorizeModel(model)
  if (type === 'embedding' || type === 'image' || type === 'audio') {
    return null
  }
  const entry: Record<string, unknown> = {
    name: formatModelName(model),
  }
  // Some deployments only report the OpenAI-style `max_tokens` total;
  // use it as the context limit when `max_input_tokens` is absent.
  const contextLimit = model.max_input_tokens ?? model.max_tokens
  if (contextLimit || model.max_output_tokens) {
    entry.limit = {
      context: contextLimit ?? 0,
      output: model.max_output_tokens ?? 0,
    }
  }
  if (model.supports_function_calling) {
    entry.tool_call = true
  }
  if (model.supports_reasoning) {
    entry.reasoning = true
  }
  if (model.supports_vision) {
    entry.attachment = true
  }
  // Only emit `cost` when LLMRouter actually reported a price. Omitting
  // it (rather than defaulting to 0) lets OpenCode/models.dev fall back
  // to their own default instead of us asserting "this model is free"
  // for something LLMRouter simply has no price anchor for (e.g. rerank).
  if (model.input_cost_per_token != null || model.output_cost_per_token != null) {
    const cost: Record<string, number> = {
      input: (model.input_cost_per_token ?? 0) * PRICE_PER_TOKEN_TO_PER_MILLION,
      output: (model.output_cost_per_token ?? 0) * PRICE_PER_TOKEN_TO_PER_MILLION,
    }
    if (model.cache_read_input_token_cost != null) {
      cost.cache_read = model.cache_read_input_token_cost * PRICE_PER_TOKEN_TO_PER_MILLION
    }
    if (model.cache_creation_input_token_cost != null) {
      cost.cache_write = model.cache_creation_input_token_cost * PRICE_PER_TOKEN_TO_PER_MILLION
    }
    entry.cost = cost
  }
  const input: Array<'text' | 'image' | 'pdf' | 'audio'> = ['text']
  if (model.supports_vision) input.push('image')
  if (model.supports_pdf_input) input.push('pdf')
  if (model.supports_audio_input) input.push('audio')
  if (input.length > 1) {
    entry.modalities = { input, output: ['text'] }
  }
  // entry.variants = info?.supportsReasoningEfforts?.length
  //   ? Object.fromEntries(
  //     info.supportsReasoningEfforts.map((effort) => [
  //       effort,
  //       { reasoningEffort: effort },
  //     ]),
  //   )
  //   : undefined
  return entry
}

/**
 * Fetch and build OpenCode model entries from a LLMRouter proxy.
 *
 * Pure with respect to plugin config: it performs the network calls,
 * classifies + formats each model, and returns a `{ id -> entry }` map.
 * Returns `null` when the proxy is unreachable/unauthorized or exposes
 * no models, so callers can distinguish "no data" from "empty result".
 */
async function discoverModels(
  baseURL: string,
  modelUrl: string,
  apiKey: string | undefined,
  customHeaders: Record<string, string> | undefined,
  providerId: string,
): Promise<Record<string, unknown> | null> {
  if (!(await checkLLMRouterHealth(baseURL, apiKey, customHeaders))) {
    console.warn(
      `[opencode-llmrouter] LLMRouter appears offline or unauthorized for provider "${providerId}" at ${baseURL}`,
    )
    return null
  }

  // `/v1/models` omits `mode` and capability metadata for
  // database-defined models, so fetch `/v1/model/info` alongside
  // it. The info call is best-effort: without it, classification
  // falls back to id heuristics.
  const [modelsResult, infoResult] = await Promise.allSettled([
    discoverLLMRouterModels(baseURL, apiKey, customHeaders),
    discoverLLMRouterModelInfo(modelUrl, apiKey, customHeaders),
  ])

  if (modelsResult.status === 'rejected') {
    const error = modelsResult.reason
    console.warn(
      `[opencode-llmrouter] Model discovery failed for provider "${providerId}":`,
      error instanceof Error ? error.message : String(error),
    )
    return null
  }

  const discovered = modelsResult.value
  let infoByName: Map<string, LLMRouterModelInfo> | null = null
  if (infoResult.status === 'fulfilled') {
    infoByName = infoResult.value
  } else {
    const reason = infoResult.reason
    console.warn(
      `[opencode-llmrouter] /v1/model/info unavailable for provider "${providerId}"; non-chat model filtering will use id heuristics only:`,
      reason instanceof Error ? reason.message : String(reason),
    )
  }

  if (discovered.length === 0) {
    console.warn(
      `[opencode-llmrouter] LLMRouter responded for provider "${providerId}" but exposed zero models.`,
    )
    return null
  }

  const built: Record<string, unknown> = {}
  let skipped = 0
  let wildcards = 0
  const unmatched: string[] = []
  for (const model of discovered) {

    // `deepseek/*` is an access rule, not a callable model. But a
    // trailing `*` (`claude-sonnet-4-6*`) is a model-group alias,  
    // so only skip the `provider/*` form.
    if (model.id.includes('/*')) {
      wildcards++
      continue
    }
    const info = infoByName?.get(model.id)
    if (infoByName && !info) unmatched.push(model.id)

    let entry;

    try {
      entry = toConfigModel(info ? enrichModel(model, info) : model, info)
    }
    catch (e) {
      console.error('[opencode-llmrouter]', 12.2, model.id, e)
    }

    if (!entry) {
      skipped++
      continue
    }
    built[model.id] = entry
  }

  if (unmatched.length > 0) {
    console.warn(
      `[opencode-llmrouter] /v1/model/info has no entry for ${unmatched.length} model(s) on provider "${providerId}"; ` +
      `classification uses id heuristics for: ${unmatched.slice(0, 5).join(', ')}` +
      (unmatched.length > 5 ? `, +${unmatched.length - 5} more` : ''),
    )
  }

  // console.log(
  //   `[opencode-llmrouter] Discovered ${discovered.length} models for provider "${providerId}" from ${baseURL} ` +
  //   `(${Object.keys(built).length} built` +
  //   (skipped > 0 ? `, ${skipped} non-chat hidden` : '') +
  //   (wildcards > 0 ? `, ${wildcards} wildcard ignored` : '') +
  //   ')',
  // )

  return built
}

/**
 * Merge freshly built model entries into a provider's `models` map
 * without clobbering user-curated (or previously injected) entries.
 * Returns the ids actually added by this call.
 */
function mergeModels(
  models: Record<string, unknown>,
  built: Record<string, unknown>,
): string[] {
  const added: string[] = []
  for (const [id, entry] of Object.entries(built)) {
    if (Object.hasOwn(models, id)) continue
    models[id] = entry
    added.push(id)
  }
  // Remove the seed placeholder if real models were merged in.
  if (Object.hasOwn(models, '_') && Object.keys(models).length > 1) {
    delete models['_']
  }
  return added
}

/**
 * Revalidate a provider's model cache off the critical path (SWR). The
 * refreshed entries land in the on-disk cache and surface on the next
 * OpenCode start — OpenCode only reads provider config at startup, so
 * we can't mutate the live picker here.
 */
async function backgroundRefresh(cacheKey: string): Promise<void> {
  if (refreshInFlight.has(cacheKey)) return
  const ctx = refreshContexts.get(cacheKey)
  if (!ctx) return
  // Skip if the cache was refreshed recently — a burst of new sessions
  // shouldn't hammer the proxy with health checks and discovery calls.
  const savedAt = readModelCacheSavedAt(cacheKey)
  if (savedAt !== null && Date.now() - savedAt < REFRESH_MIN_INTERVAL_MS) {
    return
  }
  refreshInFlight.add(cacheKey)
  try {
    const built = await withTimeout(
      discoverModels(ctx.baseURL, ctx.modelUrl, ctx.apiKey, ctx.customHeaders, ctx.providerId),
      DISCOVERY_TIMEOUT_MS,
    )
    if (built && Object.keys(built).length > 0) {
      writeModelCache(cacheKey, built)
      // console.log(
      //   `[opencode-llmrouter] Background-refreshed model cache for ${ctx.baseURL} (${Object.keys(built).length} models)`,
      // )
    }
  } catch {
    // Best-effort — a failed refresh just leaves the stale cache in place.
  } finally {
    refreshInFlight.delete(cacheKey)
  }
}

/**
 * LLMRouter Plugin for OpenCode.
 *
 * Uses the `config` hook to discover models from a LLMRouter proxy and
 * inject them into the provider's `models` map at startup. This is the
 * only reliable way to dynamically populate a provider — the
 * `provider.models` hook is not called by OpenCode for custom providers.
 *
 * Configure the provider in your `opencode.json`:
 *
 * {
 *   "plugin": ["opencode-plugin-llmrouter@latest"],
 *   "provider": {
 *     "llmrouter": {
 *       "npm": "@ai-sdk/openai-compatible",
 *       "name": "LLMRouter (proxy)",
 *       "options": {
 *         "baseURL": "http://localhost:4000/v1",
 *         "apiKey": "{env:LLMROUTER_API_KEY}"
 *       }
 *     }
 *   }
 * }
 */
export const LLMRouterPlugin: Plugin = async (_input: PluginInput) => {
  return {
    config: async (config: any) => {
      // Ensure the provider entry exists
      if (!config.provider) config.provider = {}
      // Find all matching LLMRouter providers
      const providerIds = Object.keys(config.provider)
      const llmrouterProviders: Array<{ id: string; provider: Record<string, unknown> }> = []
      for (const id of providerIds) {
        const provider = config.provider[id]
        if (provider && typeof provider === 'object') {
          const options = (provider.options ?? {}) as Record<string, unknown>
          if (isLLMRouterProvider(id, options)) {
            llmrouterProviders.push({ id, provider })
          }
        }
      }
      // If no providers are matched (e.g., zero-config auto-detection),
      // fall back to default 'llmrouter' provider to ensure backwards compatibility.
      if (llmrouterProviders.length === 0) {
        const id = CHAT_PROVIDER_ID
        let provider = config.provider[id] as Record<string, unknown> | undefined
        provider ??= {
          npm: '@ai-sdk/openai-compatible',
          name: 'LLMRouter (proxy)',
          options: {},
          models: {},
        };
        llmrouterProviders.push({ id, provider })
      }

      // Process each matched provider
      for (const { id: providerId, provider } of llmrouterProviders) {
        const options = (provider.options ?? {}) as Record<string, unknown>
        const configuredBase =
          typeof options.baseURL === 'string' ? options.baseURL : undefined
        const configuredKey =
          typeof options.apiKey === 'string' && options.apiKey
            ? options.apiKey
            : undefined
        const envKey =
          process.env.LLMROUTER_API_KEY || process.env.LLMROUTER_MASTER_KEY || undefined
        /*
        Falls back to the key OpenCode itself stored for this provider id via
        '/connect' (~/.local/share/opencode/auth.json). For a custom provider
        like this one there is no automatic auth.json injection (see below), so
        the plugin reads the stored key here and applies it to both its own
        discovery fetches and the completion-time provider options. Without it,
        a key-only proxy would fail discovery even though chat works.
        */
        const storedKey = await getOpenCodeStoredApiKey(providerId)
        const apiKey = configuredKey ?? envKey ?? storedKey
        const customHeaders = readCustomHeaders(options)

        const modelUrl = options.modelUrl as string;

        // Resolve base URL
        let baseURL: string | null = null
        if (configuredBase) {
          baseURL = normalizeBaseURL(configuredBase)
        } else {
          baseURL = await autoDetectLLMRouter(apiKey, customHeaders)
        }

        if (!baseURL) {
          console.warn(
            `[opencode-llmrouter] No LLMRouter proxy found for provider "${providerId}". Configure options.baseURL or start LLMRouter on port 4000/8000/8080.`,
          )
          continue
        }

        // Initialize/Update the provider entry in config
        if (!config.provider[providerId]) {
          config.provider[providerId] = provider
        }

        const reloadModelsSkill = `
        ---
        name: reload-models
        description: "Reloads the model list in the opencode-llmrouter plugin."
        ---

        # Do only this and nothing else. Do not add any other text or explanation.
        
        "Models reloaded."
        `

        config.skills = config.skills ?? {}
        config.skills['reload-models'] = reloadModelsSkill;

        const actualProvider = config.provider[providerId] as Record<string, unknown>

        if (!actualProvider.npm) {
          actualProvider.npm = '@ai-sdk/openai-compatible'
        }

        if (!actualProvider.options) {
          actualProvider.options = {}
        }
        const actualOptions = actualProvider.options as Record<string, unknown>
        if (!actualOptions.baseURL) {
          actualOptions.baseURL = `${baseURL}/v1`
        }
        /*
        For a fully custom, config-only provider like this one, OpenCode
        builds the real completion-time AI SDK client straight from
        `options` - there's no separate auth.json auto-injection for
        arbitrary custom providers (that only applies to a handful of
        models.dev-catalog providers with special-cased loaders). So the
        `apiKey` resolved above (config > env var > OpenCode-stored
        credential) must be written back here, or real chat completions
        go out with no Authorization header even though discovery
        succeeded using the same resolved key.
        */
        if (!actualOptions.apiKey && apiKey) {
          actualOptions.apiKey = apiKey
        }

        if (!actualProvider.models) {
          actualProvider.models = {}
        }

        const models = actualProvider.models as Record<string, unknown>

        const cacheKey = `${providerId}@${baseURL}`

        // Remember how to reach this proxy so the `event` hook can
        // revalidate its cache in the background on new sessions.
        refreshContexts.set(cacheKey, { baseURL, modelUrl, apiKey, customHeaders, providerId })

        // Repeat config-hook invocations within a run are a no-op once
        // we've injected this provider's models.
        const alreadyInjected = injectedModelIds.get(cacheKey)
        if (
          alreadyInjected &&
          [...alreadyInjected].every((id) => Object.hasOwn(models, id))
        ) {
          continue
        }

        const built = await withTimeout(
          discoverModels(baseURL, modelUrl, apiKey, customHeaders, providerId),
          DISCOVERY_TIMEOUT_MS,
        )

        if (built && Object.keys(built).length > 0) {
          const added = mergeModels(models, built)
          injectedModelIds.set(cacheKey, new Set(added))
          writeModelCache(cacheKey, built)
        } else {
          const cached = readModelCache(cacheKey)

          if (cached && Object.keys(cached).length > 0) {
            const added = mergeModels(models, cached)
            injectedModelIds.set(cacheKey, new Set(added))
            console.log(
              `[opencode-llmrouter] Loaded ${Object.keys(cached).length} models from cache for provider "${providerId}" (${baseURL}); refresh happens in the background on new sessions.`,
            )
          }
        }
      }
    },
    event: async ({ event }) => {
      // Revalidate model caches off the critical path when a new session
      // opens. Fresh data lands in the cache and surfaces on the next
      // OpenCode start (SWR).
      if (event.type === 'session.created') return
      for (const cacheKey of refreshContexts.keys()) {
        void backgroundRefresh(cacheKey)
      }

      if (event.type === 'command.executed') {
        console.log(`[opencode-llmrouter] Command executed:`,
          event.properties?.arguments,
          event.properties?.messageID,
          event.properties?.name,
          event.properties?.sessionID
        );
      }
    },
  }
}

// Re-export the responses plugin for backwards compat, but it's now a no-op.
// The config hook approach handles all models in a single provider.
export const LLMRouterResponsesPlugin: Plugin = async (_input: PluginInput) => {
  return {}
}

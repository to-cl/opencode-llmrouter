import { Model, Plugin, Provider } from '@opencode/plugin'
import {
  autoDetectLLMRouter,
  checkLLMRouterHealth,
  discoverLLMRouterModelInfo,
  discoverLLMRouterModels,
  normalizeBaseURL,
} from './utils/llmrouter-api'
import { getOpenCodeStoredApiKey } from './utils/opencode-auth'
import { readModelCache, writeModelCache } from './utils/model-cache'
import { toModelInfo, toProviderInfo } from './utils/model-mapping'
import type { LLMRouterModel, LLMRouterModelInfo } from './types'

const PLUGIN_ID = 'opencode-llmrouter'
const PROVIDER_ID = Provider.ID.make('llmrouter')
const DISCOVERY_TIMEOUT_MS = 20_000
const REFRESH_MIN_INTERVAL_MS = 5 * 60 * 1000

interface Options {
  baseURL?: string
  modelUrl?: string
  customHeaders?: Record<string, string>
}

/** Read plugin options, keeping only the shapes this plugin understands. */
function readOptions(raw: Record<string, unknown>): Options {
  const headers = raw.customHeaders
  const customHeaders =
    headers && typeof headers === 'object' && !Array.isArray(headers)
      ? Object.fromEntries(
          Object.entries(headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
        )
      : undefined
  return {
    baseURL: typeof raw.baseURL === 'string' ? raw.baseURL : undefined,
    modelUrl: typeof raw.modelUrl === 'string' ? raw.modelUrl : undefined,
    customHeaders,
  }
}

/** Race a promise against a timeout; resolves to `null` when the timeout wins. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** Fetch `/v1/models` and `/v1/model/info` and return the chat models. */
async function discover(
  baseURL: string,
  modelUrl: string,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
): Promise<{ models: LLMRouterModel[]; info?: Map<string, LLMRouterModelInfo> } | null> {
  if (!(await checkLLMRouterHealth(baseURL, apiKey, headers))) return null

  const [modelsResult, infoResult] = await Promise.allSettled([
    discoverLLMRouterModels(baseURL, apiKey, headers),
    discoverLLMRouterModelInfo(modelUrl, apiKey, headers),
  ])
  if (modelsResult.status === 'rejected' || modelsResult.value.length === 0) return null

  return {
    models: modelsResult.value,
    info: infoResult.status === 'fulfilled' ? infoResult.value : undefined,
  }
}

/** Convert a discovery result into v2 `Model.Info` entries, skipping non-chat ones. */
function buildModels(
  discovered: LLMRouterModel[],
  info: Map<string, LLMRouterModelInfo> | undefined,
): Model.Info[] {
  const built: Model.Info[] = []
  for (const model of discovered) {
    // `provider/*` is an access rule, not a callable model. A trailing `*`
    // (`claude-sonnet-4-6*`) is a model-group alias and stays.
    if (model.id.includes('/*')) continue
    if (model.id.includes('reranker') || model.id.includes('embedding')) continue
    try {
      const entry = toModelInfo(PROVIDER_ID, model, info?.get(model.id))
      if (entry) built.push(entry)
    } catch {
      // A malformed entry shouldn't drop the whole provider; skip it.
    }
  }
  return built
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const options = readOptions(ctx.options)
    const envKey = process.env.LLMROUTER_API_KEY || process.env.LLMROUTER_MASTER_KEY || undefined
    // Key precedence: env var, then the key stored by `/connect` in auth.json.
    // Keys are never read from plugin options, so they never sit in opencode.json.
    const apiKey = envKey ?? (await getOpenCodeStoredApiKey(PROVIDER_ID))
    const headers = options.customHeaders

    const baseURL = options.baseURL
      ? normalizeBaseURL(options.baseURL)
      : await withTimeout(autoDetectLLMRouter(apiKey, headers), DISCOVERY_TIMEOUT_MS)
    if (!baseURL) {
      console.warn(`[${PLUGIN_ID}] No LLMRouter proxy found. Set options.baseURL.`)
      return
    }
    const modelUrl = options.modelUrl ?? `${baseURL}/v1/model/info`
    const cacheKey = `${PROVIDER_ID}@${baseURL}`

    // Discover live; on failure fall back to the last cached model list.
    const live = await withTimeout(discover(baseURL, modelUrl, apiKey, headers), DISCOVERY_TIMEOUT_MS)
    let models: Model.Info[] = []
    if (live) {
      models = buildModels(live.models, live.info)
      if (models.length > 0) writeModelCache(cacheKey, models)
    }
    if (models.length === 0) {
      models = readModelCache<Model.Info>(cacheKey) ?? []
      if (models.length > 0) {
        console.warn(`[${PLUGIN_ID}] Proxy unreachable; using ${models.length} cached models.`)
      }
    }
    if (models.length === 0) {
      console.warn(`[${PLUGIN_ID}] No models available from ${baseURL}.`)
      return
    }

    // Transforms replay on every rebuild, so they read the captured `current`
    // value. A refresh updates it and calls reload() instead of re-adding.
    let current = models
    await ctx.provider.transform((editor) => {
      editor.add({
        info: toProviderInfo(PROVIDER_ID, baseURL, apiKey, headers),
        models: current,
      })
    })

    // Refresh on new sessions, at most once per interval. Writes the cache and
    // reloads the provider so the picker updates without a restart.
    let lastRefresh = Date.now()
    let inFlight = false
    const controller = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type !== 'session.created') continue
        if (inFlight || Date.now() - lastRefresh < REFRESH_MIN_INTERVAL_MS) continue
        inFlight = true
        lastRefresh = Date.now()
        try {
          const fresh = await withTimeout(discover(baseURL, modelUrl, apiKey, headers), DISCOVERY_TIMEOUT_MS)
          const built = fresh ? buildModels(fresh.models, fresh.info) : []
          if (built.length > 0) {
            writeModelCache(cacheKey, built)
            current = built
            await ctx.provider.reload()
          }
        } catch {
          // Best-effort: a failed refresh keeps the current model list.
        } finally {
          inFlight = false
        }
      }
    })().catch(() => {})

    return () => controller.abort()
  },
})

import type { LLMRouterModel, LLMRouterModelInfo, LLMRouterModelsResponse } from '../types'

export const DEFAULT_LLMROUTER_URL = 'http://localhost:4000'
const MODELS_ENDPOINT = '/v1/models'
const MODEL_INFO_ENDPOINT = '/v1/model/info'
// Health checks fail fast so auto-detection stays snappy; the actual
// discovery fetches get a generous budget because `/v1/model/info`
// payloads from remote proxies with many database-defined models can
// be large and slow to generate.
const HEALTH_TIMEOUT_MS = 3000
const FETCH_TIMEOUT_MS = 15000

/**
 * Normalise a base URL so the rest of the plugin can rely on a
 * predictable shape (no trailing slash, no `/v1` suffix).
 */
export function normalizeBaseURL(baseURL: string = DEFAULT_LLMROUTER_URL): string {
  let normalized = baseURL.replace(/\/+$/, '')
  if (normalized.endsWith('/v1')) {
    normalized = normalized.slice(0, -3)
  }
  return normalized
}

/** Build a full URL for a given API endpoint. */
export function buildAPIURL(baseURL: string, endpoint: string = MODELS_ENDPOINT): string {
  return `${normalizeBaseURL(baseURL)}${endpoint}`
}

function buildHeaders(apiKey?: string, customHeaders?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  const key = apiKey ?? process.env.LLMROUTER_API_KEY ?? process.env.LLMROUTER_MASTER_KEY
  if (key) {
    headers['Authorization'] = `Bearer ${key}`
  }
  if (customHeaders) {
    Object.assign(headers, customHeaders)
  }
  return headers
}

/** Lightweight ping to see whether a LLMRouter server is reachable. */
export async function checkLLMRouterHealth(
  baseURL: string = DEFAULT_LLMROUTER_URL,
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<boolean> {
  try {
    const response = await fetch(buildAPIURL(baseURL), {
      method: 'GET',
      headers: buildHeaders(apiKey, customHeaders),
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    })
    // 401 still means a server is alive — we just don't have the right
    // credentials. Surface that as "unhealthy" so the user is prompted
    // to set LLMROUTER_API_KEY.
    return response.ok
  } catch {
    return false
  }
}

/** Discover all models exposed by a LLMRouter proxy. */
export async function discoverLLMRouterModels(
  baseURL: string = DEFAULT_LLMROUTER_URL,
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<LLMRouterModel[]> {
  const url = buildAPIURL(baseURL)
  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(apiKey, customHeaders),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`LLMRouter responded with HTTP ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as LLMRouterModelsResponse
  return data.data ?? []
}

/**
 * Fetch per-model metadata (`mode`, token limits, capability flags)
 * from `/v1/model/info`, keyed by model name. `/v1/models` omits these
 * fields for database-defined models, so classification (e.g. filtering
 * out embedding models) relies on this endpoint.
 */
export async function discoverLLMRouterModelInfo(
  modelUrl: string,
  apiKey?: string,
  customHeaders?: Record<string, string>,
): Promise<Map<string, LLMRouterModelInfo>> {
  const url = modelUrl;
  const response = await fetch(url, {
    method: 'GET',
    headers: buildHeaders(apiKey, customHeaders),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })

  if (!response.ok) {
    throw new Error(`LLMRouter responded with HTTP ${response.status} ${response.statusText}`)
  }

  const data = (await response.json()) as LLMRouterModelInfo[]

  const infoByName = new Map<string, LLMRouterModelInfo>()
  for (const info of data ?? []) {
    // Add supports reasoning efforts if present in llmrouter_params
    const reasoningEffortPattern = /^supports([A-Z][a-z]+)ReasoningEffort$/
    const efforts = new Set<string>()
    for (const source of [info]) {
      if (!source || typeof source !== 'object') continue
      for (const [key, value] of Object.entries(source)) {
        const match = key.match(reasoningEffortPattern)
        if (match && value === true) {
          efforts.add(match[1].charAt(0).toLowerCase() + match[1].slice(1))
        }
      }
    }
    // if (efforts.size > 0) {
    //   info.supportsReasoningEfforts = Array.from(new Set([...(info.supportsReasoningEfforts ?? []), ...efforts]))
    // }

    // Index under every alias LLMRouter may use for this model — the
    // `/v1/models` id can match any of them depending on how the
    // deployment names its entries (alias vs upstream model string).
    const keys = [
      info.modelName,
      info.modelId,
      typeof info.modelId === 'string' ? info.modelId : undefined,
    ]
    for (const key of keys) {
      if (key && !infoByName.has(key)) {
        infoByName.set(key, info)
      }
    }
  }
  return infoByName
}

/**
 * Try the most common ports a LLMRouter proxy is started on.
 * The default `llmrouter --port` is 4000, but 8000 is also widely used
 * and 8080 is a common reverse-proxy default.
 */
export async function autoDetectLLMRouter(apiKey?: string, customHeaders?: Record<string, string>): Promise<string | null> {
  const commonPorts = [4000, 8000, 8080]
  for (const port of commonPorts) {
    const baseURL = `http://localhost:${port}`
    if (await checkLLMRouterHealth(baseURL, apiKey, customHeaders)) {
      return baseURL
    }
  }
  return null
}

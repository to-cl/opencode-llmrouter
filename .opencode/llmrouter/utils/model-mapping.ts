import { Model, Provider } from '@opencode/plugin'
import type { LLMRouterModel, LLMRouterModelInfo } from '../types'
import { categorizeModel, formatModelName } from './format-model-name'

type Money = Model.Info['cost'][number]['input']

/**
 * v2 costs are USD per million tokens; LLMRouter's `/v1/model/info` reports
 * USD per single token. `1e6` bridges the two — verified against a live
 * `x-llmrouter-response-cost` header, not just the unit names.
 */
const PRICE_PER_TOKEN_TO_PER_MILLION = 1_000_000

function perMillion(perToken: number | undefined): Money {
  return ((perToken ?? 0) * PRICE_PER_TOKEN_TO_PER_MILLION) as Money
}

/** Overlay `/v1/model/info` metadata onto a `/v1/models` entry; lean fields win. */
export function enrichModel(model: LLMRouterModel, info?: LLMRouterModelInfo): LLMRouterModel {
  if (!info) return model
  return {
    ...model,
    max_tokens: model.max_tokens ?? info.context,
    max_input_tokens: model.max_input_tokens ?? info.maxInputTokens,
    max_output_tokens: model.max_output_tokens ?? info.maxOutputTokens,
    supports_vision: model.supports_vision ?? info.modalities?.includes('Vision'),
    supports_reasoning: model.supports_reasoning ?? info.supportsReasoning,
    supports_pdf_input: model.supports_pdf_input ?? info.modalities?.includes('Vision'),
    input_cost_per_token: model.input_cost_per_token ?? info.inputCostPerToken,
    output_cost_per_token: model.output_cost_per_token ?? info.outputCostPerToken,
    cache_read_input_token_cost: model.cache_read_input_token_cost ?? info.cacheReadInputTokenCost,
  }
}

/**
 * Convert a discovered LLMRouter model into a v2 `Model.Info`. Returns `null`
 * for non-chat models (embedding, image, audio) so they stay out of the picker.
 */
export function toModelInfo(
  providerID: Provider.ID,
  model: LLMRouterModel,
  info?: LLMRouterModelInfo,
): Model.Info | null {
  const type = categorizeModel(model)
  if (type === 'embedding' || type === 'image' || type === 'audio') return null

  const enriched = enrichModel(model, info)

  const input: string[] = ['text']
  if (enriched.supports_vision) input.push('image')
  if (enriched.supports_pdf_input) input.push('pdf')
  if (enriched.supports_audio_input) input.push('audio')

  // Only emit a cost tier when LLMRouter reported a price. Otherwise leave
  // `cost` empty so OpenCode doesn't treat an unpriced model as free.
  const hasPrice = enriched.input_cost_per_token != null || enriched.output_cost_per_token != null
  const cost: Model.Info['cost'] = hasPrice
    ? [{
        input: perMillion(enriched.input_cost_per_token),
        output: perMillion(enriched.output_cost_per_token),
        cache: {
          read: perMillion(enriched.cache_read_input_token_cost),
          write: perMillion(enriched.cache_creation_input_token_cost),
        },
      }]
    : []

  const base = Model.Info.default(providerID, Model.ID.make(model.id))
  return {
    ...base,
    name: formatModelName(model),
    capabilities: {
      tools: enriched.supports_function_calling === true,
      input,
      output: ['text'],
    },
    limit: {
      context: enriched.max_tokens ?? 0,
      output: enriched.max_output_tokens ?? 0,
      ...(enriched.max_input_tokens ? { input: enriched.max_input_tokens } : {}),
    },
    cost,
  }
}

/**
 * Provider metadata for the LLMRouter proxy. Built fresh on every startup from
 * plugin options and the resolved key; it is never written to the cache, so
 * secrets in `settings` or `headers` stay out of ~/.cache.
 */
export function toProviderInfo(
  providerID: Provider.ID,
  baseURL: string,
  apiKey: string | undefined,
  headers: Record<string, string> | undefined,
): Provider.Info {
  return {
    ...Provider.Info.empty(providerID),
    name: 'LLMRouter',
    activation: 'enabled',
    package: '@ai-sdk/openai-compatible',
    settings: { baseURL: `${baseURL}/v1`, ...(apiKey ? { apiKey } : {}) },
    headers: headers ?? {},
  }
}

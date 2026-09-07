// Core types for the LLMRouter OpenCode plugin

/**
 * A single model entry returned by LLMRouter's `/v1/models` endpoint.
 * LLMRouter follows the OpenAI-compatible schema.
 */
export interface LLMRouterModel {
  id: string
  object: string
  created?: number
  owned_by?: string
  /**
   * LLMRouter-specific extension. Some deployments include the underlying
   * provider (e.g. "openai", "anthropic", "bedrock") here.
   */
  llmrouter_provider?: string
  /**
   * Optional capability metadata. Present on `/v1/models` only for some
   * deployments; reliably available via `/v1/model/info` and merged onto
   * the discovered entry by the plugin.
   *
   * Newer LLMRouter versions may expose `'responses'` here for models
   * that must be routed through the OpenAI Responses API rather than
   * `/v1/chat/completions` (e.g. `gpt-5*`, `o1/o3/o4*` with reasoning).
   */
  mode?: string
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  supports_function_calling?: boolean
  supports_vision?: boolean
  supports_reasoning?: boolean
  supports_pdf_input?: boolean
  supports_audio_input?: boolean
  /**
   * USD price per input/output token, reliably available via
   * `/v1/model/info` (`/v1/models` omits pricing). Absent for models
   * LLMRouter has no price anchor for (e.g. rerank) — treat as "unknown",
   * not "free".
   */
  input_cost_per_token?: number
  output_cost_per_token?: number
  cache_read_input_token_cost?: number
  cache_creation_input_token_cost?: number
}

export interface LLMRouterModelsResponse {
  object: string
  data: LLMRouterModel[]
}

/**
 * The `model_info` block of a `/v1/model/info` entry. This endpoint
 * reliably carries `mode` (and token limits) even for database-defined
 * models, where `/v1/models` only returns the lean OpenAI schema.
 */
// export interface LLMRouterModelInfo {
//   id?: string
//   dbModel?: boolean
//   /** Alias LLMRouter assigns to the model; mirrors the `/v1/models` id. */
//   key?: string
//   mode?: string
//   maxTokens?: number
//   maxInputTokens?: number
//   maxOutputTokens?: number
//   supportsFunctionCalling?: boolean
//   supportsVision?: boolean
//   supportsReasoning?: boolean
//   supportsReasoningEfforts?: string[]
//   supportsPdfInput?: boolean
//   supportsAudioInput?: boolean
//   inputCostPerToken?: number
//   outputCostPerToken?: number
//   cacheReadInputTokenCost?: number
//   cacheCreationInputTokenCost?: number
// }


export interface LLMRouterModelInfo {
  modelName: string;
  modelId: string;
  proxyProvider: string;
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadInputTokenCost: number;
  outputCostPerReasoningToken: number;
  supportsReasoning: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  supportedParameters: string[];
  modelUrl: string;
  modelHost: string;
  modelRegion: string;
  modelCreator: string;
  provider: string;
  modelOrigin: string;
  series: string;
  providerCountry: string;
  datacenterCountries: string[];
  training: boolean;
  dataRetention: boolean;
  docs: string;
  context: number;
  modalities: string[];
  accessGroups: string[];
}


/** A single entry returned by LLMRouter's `/v1/model/info` endpoint. */
// export interface LLMRouterModelInfoEntry {
//   modelName: string
//   llmrouterParams?: Record<string, unknown>
//   modelInfo?: LLMRouterModelInfo
// }

export interface LLMRouterModelInfoResponse {
  data?: LLMRouterModelInfo[]
}

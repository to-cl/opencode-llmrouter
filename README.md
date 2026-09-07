# Opencode Plugin for LLMrouter.eu
Load the model list automatically including cost, token limits, and modalities.

## Setup 

```
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "tbd.: git-url"
  ],
  "provider": {
    "llmrouter": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "LLMrouter",
      "options": {
        "baseURL": "https://proxy.llmrouter.eu/v1",
        "modelUrl": "https://backend.llmrouter.eu/public/models",
        "includeUsage": true
      }
    }
  }
}

```
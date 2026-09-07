<div align="center">

<div style="display: flex; flex-direction: row; align-items: center; justify-content: center; gap: 3em; margin-bottom: 2em">
<img src="img/llmrouter-logo.svg">
<div>
X
</div>
<img src="img/opencode-logo.svg">
</div>

# Opencode Plugin for LLMrouter.eu
Load the model list automatically including cost, token limits, and modalities.

</div>


## Setup
in your `opencode.json` add the following:
```
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-llmrouter@git+https://github.com/to-cl/opencode-llmrouter.git"
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
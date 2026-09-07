<div align="center">

<div style="display: flex; flex-direction: row; align-items: center; justify-content: center; gap: 3em; margin-bottom: 2em">
<img src="img/llmrouter-logo.svg" height=70px>
<div>
X
</div>
<img src="img/opencode-logo.svg" height=50px>
</div>

# Opencode Plugin for LLMrouter.eu
Load the model list automatically including cost, token limits, and modalities.

</div>


## Setup

1. Open opencode and type `/connect`

<img src="img/connect.png">

2. Search for `other` and click on `Other Custom Provider`

<img src="img/other-provider.png">

3. Type `llmrouter` or `llmrouter-{something}` or `llmrouter_{something}` and press enter

<img src="img/provider-name.png">

4. Paste your LLMrouter.eu API-key and press enter

<img src="img/api-key.png">

5. For a global setup of opencode go to `"C:\Users\{UserName}\.config\opencode\opencode.jsonc"` and add the following

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
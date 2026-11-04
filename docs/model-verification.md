# DashScope model verification

Checked on 2026-11-04. Sources are development notes, not runtime model-card fields.

## deepseek-v4-pro-0813

- [contextTokens, maxInputTokens, maxInputTokensThinking, maxOutputTokens, maxThinkingTokens, capabilities, inputMedia](https://help.aliyun.com/en/model-studio/deepseek-v4-pro): Model facts for Alibaba Cloud hosting in Beijing; not application execution limits.
- [thinkingLevelMap, adapterId](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-responses): Responses-specific canonical effort values; no automatic alias mapping in Whim.

## deepseek-v4.1-flash

- [contextTokens, maxInputTokens, maxInputTokensThinking, maxOutputTokens, maxThinkingTokens, capabilities, inputMedia](https://help.aliyun.com/en/model-studio/deepseek-v4-1-flash): Model facts for Alibaba Cloud hosting in Beijing; not application execution limits.
- [thinkingLevelMap, adapterId](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-responses): Responses-specific canonical effort values; no automatic alias mapping in Whim.
- [inputMedia.image/png](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-responses): The model page confirms images and the Responses input_image contract specifies PNG data URIs. Other MIME formats and byte limits remain unverified; do not inherit Qwen limits.

## glm-5.3-prime

- [contextTokens, maxInputTokens, maxInputTokensThinking, maxOutputTokens, maxThinkingTokens, capabilities, inputMedia](https://help.aliyun.com/en/model-studio/glm-5-3): Model facts for Alibaba Cloud hosting in Beijing; not application execution limits.
- [thinkingLevelMap, adapterId](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-responses): Responses-specific canonical effort values; no automatic alias mapping in Whim.
- [modelId, contextTokens, capabilities, thinkingLevelMap](https://help.aliyun.com/en/model-studio/prime-mode): Prime inherits the original model capabilities and limits; direct Alibaba Cloud hosting, not ZHIPU/GLM-5.3.

## kimi-k3

- [contextTokens, maxInputTokens, maxInputTokensThinking, maxOutputTokens, maxThinkingTokens, capabilities, inputMedia](https://help.aliyun.com/en/model-studio/aliyun-kimi-k3): Model facts for Alibaba Cloud hosting in Beijing; not application execution limits.
- [thinkingLevelMap, adapterId](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-responses): Responses-specific canonical effort values; no automatic alias mapping in Whim.
- [inputMedia](https://help.aliyun.com/en/model-studio/kimi-api): Image MIME list and raw/encoded size limits; below 4K all listed formats, 4K–8K JPEG/PNG only. Additional dimensions and aspect-ratio checks apply.
- [thinkingLevelMap](https://help.aliyun.com/en/model-studio/kimi-api): Thinking cannot be disabled. Responses effort levels are undocumented. Only the high application level is exposed, mapped to enable_thinking=true; no unsupported effort value is sent. Beijing Responses text/stream probes passed on 2026-11-04 despite conflicting documentation.

## qwen3.8-flash

- [contextTokens, maxInputTokens, maxInputTokensThinking, maxOutputTokens, maxThinkingTokens, capabilities, inputMedia](https://help.aliyun.com/en/model-studio/qwen3-8-flash): Model facts for Alibaba Cloud hosting in Beijing; not application execution limits.
- [thinkingLevelMap, adapterId](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-responses): Responses-specific canonical effort values; no automatic alias mapping in Whim.
- [inputMedia](https://help.aliyun.com/en/model-studio/vision): Image MIME list and raw/encoded size limits; below 4K all listed formats, 4K–8K JPEG/PNG only. Additional dimensions and aspect-ratio checks apply.

## qwen3.8-max

- [contextTokens, maxInputTokens, maxInputTokensThinking, maxOutputTokens, maxThinkingTokens, capabilities, inputMedia](https://help.aliyun.com/en/model-studio/qwen3-8-max): Model facts for Alibaba Cloud hosting in Beijing; not application execution limits.
- [thinkingLevelMap, adapterId](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-responses): Responses-specific canonical effort values; no automatic alias mapping in Whim.
- [inputMedia](https://help.aliyun.com/en/model-studio/vision): Image MIME list and raw/encoded size limits; below 4K all listed formats, 4K–8K JPEG/PNG only. Additional dimensions and aspect-ratio checks apply.

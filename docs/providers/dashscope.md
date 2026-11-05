# DashScope (Alibaba Cloud Model Studio)

Verified facts used by `@whimkit/plugin-dashscope`. Re-verify before changing the adapter or seed cards and update the dates.

## Sources

| Source                                                                                                | Page updated | Checked    |
| ----------------------------------------------------------------------------------------------------- | ------------ | ---------- |
| [Responses API](https://www.alibabacloud.com/help/zh/model-studio/qwen-api-via-openai-responses)      | 2026-10-29   | 2026-11-04 |
| [Error codes](https://www.alibabacloud.com/help/zh/model-studio/error-code)                           | 2026-11-04   | 2026-11-04 |
| [GLM-5.3](https://docs.bailian.console.aliyun.com/zh/model-studio/glm-5-3.md)                         | —            | 2026-11-05 |
| [Kimi-K3.1-Pro](https://docs.bailian.console.aliyun.com/zh/model-studio/kimi-k3-1-pro.md)             | —            | 2026-11-05 |
| [DeepSeek-V4.1-Flash](https://docs.bailian.console.aliyun.com/zh/model-studio/deepseek-v4-1-flash.md) | —            | 2026-11-05 |
| [Web extractor](https://help.aliyun.com/zh/model-studio/web-extractor)                                | —            | 2026-11-05 |

## Endpoint

- Base URL `https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1`, request path `/responses`. Regions: `ap-southeast-1`, `cn-beijing`, `us-east-1`, `eu-central-1`, `cn-hongkong`, `ap-northeast-1`. The credential takes one optional full `baseUrl`; the default used when it is empty is verified in PR 2.
- The legacy path `/api/v2/apps/protocols/compatible-mode/v1/responses` is no longer maintained.
- Unlisted OpenAI parameters are ignored, not rejected. `background` is unsupported.

## Models

Listed with full Responses support (built-in tools): `qwen3.8-max`, `qwen3.8-flash`, `qwen3.8-omni-flash`, `qwen3.7-*`, `qwen3.6-*`, `qwen3.5-*`, `deepseek-v4.1-flash`, `deepseek-v4-pro`, `deepseek-v4-flash-0731`, `glm-5.3`, `glm-5.2`, `kimi-k3`, with dated variants. Other text models get basic compatibility only.

## Thinking

- `reasoning.effort`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`; supported levels and defaults vary by model. It takes precedence over `enable_thinking`, which is deprecated.
- Default mapping from Whim levels: `off→none`, `low→low`, `medium→medium`, `high→high`, `max→max`. Cards override it through `options.effort` where a model's levels differ.
- Supported `reasoning.effort` per model (Responses API reference, checked 2026-11-05); unlisted values are mapped by the service to a neighbouring level:

| Model                          | Levels                                     | Whim card levels                                                                    |
| ------------------------------ | ------------------------------------------ | ----------------------------------------------------------------------------------- |
| `qwen3.8-max`, `qwen3.8-flash` | `none`, `low`, `medium`, `xhigh` (default) | `off`, `low`, `medium`, `high` (sent as `xhigh`)                                    |
| `deepseek-v4.1-flash`          | `none`, `low`, `high` (default), `max`     | `off`, `low`, `high`, `max`                                                         |
| `glm-5.3`                      | `low`, `high`, `max` (default)             | `low`, `high`, `max`; thinking cannot be turned off                                 |
| `kimi-k3.1-pro`                | `low`, `medium`, `high`, `max` (default)   | `low`, `medium`, `high`, `max`; turning thinking off is discouraged and not offered |

- `deepseek-v4.1-flash-1017` is not listed in the effort table; it is assumed to follow `deepseek-v4.1-flash` (unverified).

## Input

- `input_text`: all roles. `input_image`: user only, public URL or Base64 data URI.
- `input_file` (PDF): user only, up to 100 MB; only `qwen3.8-flash`, `qwen3.8-max`, `qwen3.5-ocr`. Page limit 10, or 50 with `ocr_options.task = document_parsing`.
- `input_video` (`video_url`, optional `fps`) and `input_audio`: only `qwen3.8-omni-flash`. Video requires a URL, so local files are not deliverable natively without an upload route.

## Built-in tools

`web_search`, `web_extractor` (requires `web_search`), `code_interpreter`, `web_search_image`, `image_search`, `file_search` (one vector store id), `mcp`, plus `function`. `qwen3.8-omni-flash` supports only `web_search`.

Whim mapping: `web_search → web_search`, `web_fetch → web_extractor`. `code_interpreter` is a plugin-namespaced native tool.

- `web_extractor` requires `web_search` and thinking mode (Web extractor page: "必须开启思考模式"). With `reasoning.effort: none`, `qwen3.8-max` returns `400 InternalError.Algo.InvalidParameter: Normal mode does not support web_extractor. Please set enable_thinking to true.` (observed 2026-11-05). The adapter omits `web_extractor` from requests whose thinking level maps to `none`; web search stays available.
- The documentation requires thinking mode for `code_interpreter` on `qwen3.8-max`, `qwen3.8-flash`, and `qwen3.7-max` variants.

## Streaming and state

- Events include `response.output_text.delta`, `response.reasoning_text.delta`, `response.output_item.added|done`, tool progress events (`web_search_call.*`, `code_interpreter_call.*`, …), `response.incomplete`, and `response.completed` as the terminal event. Web extraction has no progress events; it is observed through output items.
- `store` defaults to `true`; Whim sends `store: false` and replays context locally. `previous_response_id` is not used.
- Replaying reasoning output items under `store: false` is unverified, so the adapter does not persist or resend them; visible text is replayed.
- Input above roughly 80% of the context window is **silently truncated**. The adapter's `inputBudget` must stay below that point.
- Session cache header `x-dashscope-session-cache: enable` exists; not used until measured.

## Usage

`input_tokens`, `output_tokens`, `total_tokens`; `input_tokens_details.cached_tokens`, `cache_creation_input_tokens`; `output_tokens_details.reasoning_tokens`. Cached and reasoning counts are subsets and are not added again.

## Error mapping

| Status | Code                                               | Category            | Retry                                 |
| ------ | -------------------------------------------------- | ------------------- | ------------------------------------- |
| 401    | `InvalidApiKey`                                    | `authentication`    | after-change: credential              |
| 403    | `AccessDenied`                                     | `permission`        | after-change: configuration           |
| 403    | `Arrearage`                                        | `account`           | after-change: account                 |
| 429    | `Throttling.RateQuota`, `Throttling.Concurrency`   | `rate-limited`      | backoff                               |
| 429    | `Throttling.AllocationQuota`, `insufficient_quota` | `rate-limited`      | backoff (bounded); surface quota hint |
| 400    | `InvalidParameter` (input length)                  | `context-limit`     | after-change: input                   |
| 400    | `InvalidParameter` (other)                         | `invalid-request`   | never                                 |
| 400    | `DataInspectionFailed`                             | `content-filtered`  | after-change: input                   |
| 404    | `ModelNotFound`                                    | `model-unavailable` | after-change: configuration           |
| 500    | `InternalError`                                    | `overloaded`        | backoff                               |
| 503    | `ServiceUnavailable`, `ModelUnavailable`           | `overloaded`        | backoff                               |
| —      | connection error                                   | `transport`         | backoff                               |

Codes are compared case-insensitively; snake_case aliases map identically. `response.failed` and `response.incomplete` in-stream map to `protocol` with `outcome` `partial` when output was published.

## Seed cards

`qwen3.8-max` and `qwen3.8-flash` ship with conservative, unverified limits (262144-token context, 32768 output tokens), because the official model list did not state their limits on 2026-11-04.

| Card                       | Context   | Output    | Native tools                              | Documented input (declared: text only) |
| -------------------------- | --------- | --------- | ----------------------------------------- | -------------------------------------- |
| `deepseek-v4.1-flash-1017` | 1,000,000 | 393,216   | `web_search`, `web_extractor`             | text, image                            |
| `kimi-k3.1-pro`            | 1,048,576 | 1,048,576 | `web_search`, `web_extractor`             | text, image                            |
| `glm-5.3`                  | 1,048,576 | 131,072   | none (model page: web search unsupported) | text                                   |

`code_interpreter`, which DeepSeek and Kimi also support, is not mapped yet. Only text input is declared until image and PDF delivery are implemented. Users can correct values with a patch file in the `models` directory. The adapter's input budget is 75% of `contextWindow`, below the silent-truncation point.

## Icons

`icons/bailian.svg` and `icons/qwen.svg` are the colored Bailian and Qwen marks from `@lobehub/icons-static-svg` 1.102.0 (MIT). The marks remain trademarks of their owners and identify the provider and model family only.

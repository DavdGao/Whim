# TypeSafe

Facts used by `@whimkit/plugin-typesafe`, which implements the Decision adapter `@whimkit/plugin-typesafe#system-one` over TypeSafe's System One API. Verified on 2026-11-05 against the published OpenAPI contract (`https://api.typesafe.ai/openapi.json`, version 0.2.0) and the API reference at `https://docs.typesafe.ai/api`. No live call has been made: access needs an approved account, so the adapter is verified with fixtures and a local mock only.

## Endpoint

- `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer <API_KEY>`, JSON body. The credential's optional `baseUrl` replaces the origin (for gateways such as LiteLLM's pass-through).
- Request: `model` (name or alias; `GET /v1/models` lists them), `state` (string, object, or array), `questions` (named, at least one). Optional `assets` and the `TypeSafe-Danger-Zone-*` headers are not used.
- The adapter sends only `choice` questions: `{ type: "choice", instructions, criteria }`, where `criteria` maps 1–255 choice names to descriptions.
- Response: `model` (may differ from the alias), `answers` keyed by question name, `usage { input_tokens, output_tokens }` (both required; output tokens are currently free).
- A choice answer is `{ type: "choice", choice, confidence, probabilities }`; `confidence` is 0–1 and meant to be thresholded. The adapter rejects an answer of another type or a choice that was not offered.
- No streaming.

## Errors

The contract documents `400 { detail: string | object }` and `422 { detail: [{ loc, msg, type }] }`; both map to `invalid-request` with the detail as message. 401, 403, 404, 429, and 5xx are not documented and are mapped by standard HTTP meaning (authentication, permission, model unavailable, rate limited, overloaded).

## Card

`typesafe/jev` uses the alias `jev-latest`. Third-party write-ups name the current model `jev-1.13.0`; the alias is used so the card follows the provider's current release. No context limit is published, so the card states none; the reviewer's state is small (bounded user messages and one call).

## Icons

`icons/typesafe.svg` is the TypeSafe AI mark from `@lobehub/icons-static-svg` 1.102.0 (MIT). The mark remains a trademark of its owner and identifies the provider only.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.11.2] - 2026-10-14

### Fixed
- OpenRouter proxy no longer fails a request with a 400 when Claude Code
  sends a message with `content: null`.
- An upstream connection that drops mid-stream now closes the stream to
  Claude Code instead of leaving it waiting until its own timeout. This
  applies to the OpenRouter proxy and to mixed-mode Anthropic passthrough,
  which now share one relay. Mixed-mode passthrough also stops upstream
  generation when Claude Code cancels a request.
- A client request with a `Trailer` header no longer crashes the proxy.

## [0.11.1] - 2026-10-14

### Fixed
- OpenRouter prompt caching for non-Anthropic models. Claude Code adds a
  system-role message on most turns, and OpenRouter moves every system
  message into the provider's system prompt, so the prompt prefix changed
  on each call and the provider's cache never hit. The OpenRouter backend
  now runs through a local proxy that appends those messages to the
  preceding user message. A 6-turn Gemini agent task went from 0 to 89% of
  input tokens read from cache. Anthropic models are unchanged. Mixed-mode
  OpenRouter slots get the same fix, and now stop upstream generation when
  Claude Code cancels a request.

## [0.11.0] - 2026-08-09

### Added
- llama.cpp backend (`--llamacpp`, long-only so claude's `-p`/`--print`
  still passes through): points Claude Code directly at a
  `llama-server` instance. llama-server implements the Anthropic Messages API
  natively, so no translation proxy is involved; the served context window is
  read from `/props`. Setup prompts for the server URL, so LAN hosts work
  without editing the config file. Also available as a mixed-mode slot backend
  (`llamacpp:<model>`).

### Changed
- Backend launch flows unified behind a declarative registry; adding a
  backend is now a single entry. Config file format unchanged.

### Fixed
- Mixed-mode `@effort` suffixes are now only appended and stripped for
  backends that support the pin (Codex, Grok, Kimi), so slot model ids that
  legitimately contain `@` (LM Studio quant tags, HF revisions) are no longer
  truncated with the tail misread as a reasoning effort.
- Codex and Grok mixed routes now register only when a login is present,
  matching the other backends: an unauthenticated `/model codex:...` falls
  through to Anthropic's model error instead of failing inside the handler.
- Codex mixed routes honor the configured reasoning effort instead of a
  hardcoded `medium`.
- Unreachable NIM endpoints report a clean connection error instead of a
  stack trace.

## [0.10.0] - 2026-07-20

### Added
- `-b` model pickers now offer a "← Back (backend selection)" entry to return
  to the backend list instead of committing to the first choice.
- Claude Code's native `/effort` selector now drives Codex reasoning effort:
  the proxy maps `output_config.effort` onto the Responses API enum, with the
  configured backend effort as fallback.
- Mixed slots can pin reasoning effort with a `@effort` model suffix
  (`codex:gpt-5.6-sol@max`, `kimi:k3@high`): the slot picker offers "Obey
  session /effort" or a pinned level, the pin is visible wherever the model
  name shows, it works typed into `/model` mid-session, and it overrides the
  session effort by rewriting `output_config.effort` before dispatch.
- Mixed backend (`-x` / `--mixed`): route each Claude Code role slot
  (main/opus/sonnet/haiku) to any backend in one session. Slots default to the
  Anthropic Pro/Max subscription; any slot can route to Codex (ChatGPT sub),
  Grok, Kimi, OpenRouter, Ollama, NIM, or LM Studio. Slot models are stored as
  `backend:model` and a local proxy routes per request on that prefix -
  translation backends reuse the existing per-backend handlers, unprefixed
  models pass through byte-for-byte to api.anthropic.com so the OAuth session
  keeps working. Every backend with usable credentials is registered at
  launch, so `/model codex:gpt-5.6-sol` (or `kimi:k3`, `ollama:qwen3`)
  mid-session reaches backends beyond the configured slots. `ANTHROPIC_AUTH_TOKEN` and
  `ANTHROPIC_API_KEY` are stripped from the launch env - their presence alone
  switches Claude Code out of subscription OAuth mode.

## [0.9.0] - 2026-07-18

### Added
- Kimi backend (`-k` / `--kimi`): run Claude Code on a Kimi Code subscription.
  Reuses the existing `~/.kimi-code` CLI login with OAuth token refresh,
  discovers plan models live (`k3` at 1M context, `kimi-for-coding` variants),
  sends the CLI identity headers the backend expects, and defaults every role
  to the picked model.

### Fixed
- Grok and Kimi proxies no longer write a JSON error body into an
  already-started SSE stream on mid-stream failures.

## [0.8.0] - 2026-07-12

### Added
- Grok backend (`-g` / `--grok`): run Claude Code on an X / SuperGrok
  subscription. Reuses the existing `~/.grok` (Grok Build) login with OIDC
  token refresh, discovers models live, and defaults every role to the picked
  model since a flat subscription has no per-token saving from a cheaper tier
  (opt into a faster model for lighter roles). Grok's backend speaks the
  Anthropic API natively, so the proxy is a pass-through that injects the
  session token and the required client-version header.
- Shared `anthropic-adapter` that normalizes incoming Claude Code requests
  before any backend translation: coerces null message content to an empty
  block list and flattens non-standard content blocks (e.g. `tool_reference`)
  to text. This fixes a latent crash on null content that affected the Codex,
  NIM, and LM Studio proxies.

### Fixed
- LM Studio context window is read from the native `/api/v0/models`
  (`loaded_context_length`, the served window), since the OpenAI-compatible
  `/v1/models` omits context entirely. The >200K override now applies for
  LM Studio.
- Codex: single-flight token refresh, stream termination on upstream failure,
  and a guarded tool-argument parse.

## [0.7.0] - 2026-07-12

### Added
- Codex backend (`-c` / `--codex`): run Claude Code on a ChatGPT subscription.
  Reuses the existing `~/.codex` login (OAuth token, auto-refreshed), discovers
  available models from Codex's own cache, maps the flagship/mid/cheap tiers
  onto Claude Code's opus/sonnet/haiku task roles, and lets you pick a reasoning
  effort. Translates Claude Code's requests to the Codex Responses API.
- Context-window override for non-Anthropic backends. Sets
  `CLAUDE_CODE_MAX_CONTEXT_TOKENS` together with `DISABLE_COMPACT` (the override
  is only honored when auto-compaction is off) to reach a model's real window
  past Claude Code's 200K cap. This is the approach that actually works for
  third-party models, where the reverted `CLAUDE_CODE_CONTEXT_1M` did not.
  Applied only when the served window exceeds 200K, using each backend's own
  context source: OpenRouter `context_length`, LM Studio `loaded_context_length`
  (via the native `/api/v0/models`, since `/v1/models` omits it), Codex model
  cache, NIM `max_model_len`, and Ollama `/api/show`.
- `[cloud]` tag for Ollama cloud models (`:cloud`) in the picker.

## [0.6.3] - 2026-06-20

### Removed
- Revert the `CLAUDE_CODE_CONTEXT_1M` env var. Verified (multi-source research,
  Claude Code v2.1.x) that Claude Code caps non-first-party models at 200K via
  an internal `api.anthropic.com`-only context-detection gate; no shipped env
  var or setting lifts it for OpenRouter models, and `CLAUDE_CODE_CONTEXT_1M`
  is a no-op. See anthropics/claude-code#46416 (closed "not planned").

## [0.6.2] - 2026-06-20

### Added
- Enable 1M context for capable OpenRouter models via `CLAUDE_CODE_CONTEXT_1M=true`.
  Claude Code caps unrecognized models at 200K; this env var lifts it to the
  model's full window. Replaces the reverted `[1m]` suffix approach, which broke
  model resolution (the suffix is Anthropic-first-party only).

## [0.6.1] - 2026-06-19

### Removed
- Revert 1M context `[1m]` suffix. The suffix is an Anthropic-first-party Claude
  Code convention; appended to an OpenRouter model ID it is passed through
  literally and rejected ("model may not exist"). Claude Code provides no
  supported way to lift its 200K context cap for non-Anthropic models.

## [0.6.0] - 2026-06-19

### Added
- Auto-enable 1M context (`[1m]` suffix) for OpenRouter models that advertise it

## [0.5.0] - 2026-05-18

### Added
- LM Studio backend support (`-s, --lmstudio`) via the translation proxy

## [0.4.0] - 2026-03-02

### Added
- NVIDIA NIM backend support (`-n, --nim`)
- NIM cloud and self-hosted endpoint support
- In-process Anthropic-to-OpenAI translation proxy for NIM
- Role model configuration for NIM

## [0.3.0] - 2026-01-21

### Added
- Role model configuration for Ollama backend

## [0.2.0] - 2026-01-21

### Added
- Ollama backend support (`-l, --ollama`)
- Auto-filter to tool-capable Ollama models via `/api/show` capabilities check
- Show count of hidden non-tool-capable models

## [0.1.1] - 2025-01-14

### Fixed
- Replace Bun-specific APIs with Node.js equivalents for npm compatibility

## [0.1.0-beta.4] - 2025-12-26

### Added
- OAuth PKCE login flow for OpenRouter (`claude-launcher login`)
- Multi-model configuration (sonnet/opus/haiku roles)
- Exacto variant detection and auto-selection
- New model notifications
- Graceful Ctrl+C handling

### Changed
- Bundle to JS for npm (no bun dependency at runtime)
- Use `ANTHROPIC_AUTH_TOKEN` for OpenRouter auth

### Fixed
- Correct env vars for OpenRouter integration

## [0.1.0] - 2025-12-25

### Added
- Initial release
- Backend selection (Anthropic, OpenRouter)
- Model picker with search
- Config persistence

[Unreleased]: https://github.com/paddo/claude-launcher/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/paddo/claude-launcher/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/paddo/claude-launcher/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/paddo/claude-launcher/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/paddo/claude-launcher/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/paddo/claude-launcher/compare/v0.1.0-beta.4...v0.1.1
[0.1.0-beta.4]: https://github.com/paddo/claude-launcher/compare/v0.1.0...v0.1.0-beta.4
[0.1.0]: https://github.com/paddo/claude-launcher/releases/tag/v0.1.0

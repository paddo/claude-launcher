# claude-launcher

[![npm version](https://img.shields.io/npm/v/claude-launcher)](https://www.npmjs.com/package/claude-launcher)
[![license](https://img.shields.io/npm/l/claude-launcher)](LICENSE)

Launch Claude Code with multiple backends (Anthropic, OpenRouter, Ollama, NVIDIA NIM, LM Studio, llama.cpp).

## Features

- **Multiple backends** - Anthropic, OpenRouter, Ollama, NVIDIA NIM, LM Studio, llama.cpp
- **OAuth login** - authenticate with `claude-launcher login`
- **Model picker** - searchable model selection
- **Exacto support** - auto-uses `:exacto` variants for better tool calling
- **Role models** - configure different models for sonnet/opus/haiku tasks
- **New model alerts** - notifies when new models are available
- **Local backends** - run fully offline via Ollama, LM Studio, or llama.cpp

## Install

```bash
npm install -g claude-launcher
# or
pnpm add -g claude-launcher
# or
yarn global add claude-launcher
# or
bun add -g claude-launcher
```

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed.

## Usage

```bash
claude-launcher                    # launch with saved settings
claude-launcher login              # authenticate with OpenRouter
claude-launcher logout             # clear stored credentials
claude-launcher -b                 # pick backend and model
claude-launcher -a                 # use Anthropic backend
claude-launcher -o                 # use OpenRouter backend
claude-launcher -l                 # use Ollama backend (local)
claude-launcher -n                 # use NVIDIA NIM backend
claude-launcher -s                 # use LM Studio backend (local)
claude-launcher -p                 # use llama.cpp backend (local)
claude-launcher -k                 # use Kimi backend (Kimi Code subscription)
claude-launcher -x                 # use Mixed backend (Anthropic native + any backend per role slot)
claude-launcher -- --resume        # pass args to claude
```

## Backends

- **Anthropic** - standard Claude Code, no extra config
- **OpenRouter** - any model via OpenRouter; OAuth login or `OPENROUTER_API_KEY`
- **Codex** - run Claude Code on a ChatGPT subscription (reuses the `codex` CLI login)
- **Grok** - run Claude Code on an X/SuperGrok subscription (reuses the `grok` CLI login)
- **Kimi** - run Claude Code on a Kimi Code subscription (reuses the `kimi` CLI login)
- **Mixed** - any backend per role slot in one session: main/opus/sonnet/haiku each stay on the Claude Pro/Max subscription or route to Codex, Grok, Kimi, OpenRouter, Ollama, NIM, LM Studio, or llama.cpp. Slot models use a `backend:model` prefix and requests are routed per model, so `/model codex:gpt-5.6-sol` or `/model ollama:qwen3` mid-session works.
- **Ollama** - local models, auto-filtered to tool-capable ones
- **NVIDIA NIM** - cloud (`NVIDIA_API_KEY`) or self-hosted endpoints
- **LM Studio** - local models via the LM Studio server (host must include `/v1`, e.g. `http://localhost:1234/v1`)
- **llama.cpp** - a local or LAN `llama-server` instance; setup prompts for the server URL (server root, e.g. `http://localhost:8080` or `http://my-box.local:8080`)

NIM and LM Studio run through an in-process Anthropic-to-OpenAI translation proxy. Ollama and llama.cpp speak the Anthropic Messages API natively, so Claude Code talks to them directly.

## First Run

1. Run `claude-launcher -b`
2. Select a backend
3. Provide credentials if the backend needs them
4. Pick a model
5. Optionally configure role models (sonnet/opus/haiku)

## Configuration

Settings stored at `~/.config/claude-launcher/config.json`:
- Backend preference
- Selected models (main, sonnet, opus, haiku)
- API key (if logged in via OAuth)

## Environment Variables

- `OPENROUTER_API_KEY` - fallback if not logged in via OAuth
- `NVIDIA_API_KEY` - NIM cloud API key

## License

MIT

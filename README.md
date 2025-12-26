# claude-launcher

[![npm version](https://img.shields.io/npm/v/claude-launcher)](https://www.npmjs.com/package/claude-launcher)
[![license](https://img.shields.io/npm/l/claude-launcher)](LICENSE)

Launch Claude Code with multiple backends (Anthropic, OpenRouter).

## Features

- **OpenRouter integration** - use any model via OpenRouter
- **OAuth login** - authenticate with `claude-launcher login`
- **Model picker** - searchable model selection
- **Exacto support** - auto-uses `:exacto` variants for better tool calling
- **Role models** - configure different models for sonnet/opus/haiku tasks
- **New model alerts** - notifies when new models are available

## Install

```bash
npm install -g claude-launcher
```

Requires [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed.

## Usage

```bash
claude-launcher                    # launch with saved settings
claude-launcher login              # authenticate with OpenRouter
claude-launcher logout             # clear stored credentials
claude-launcher -m                 # pick a model
claude-launcher -o                 # use OpenRouter backend
claude-launcher -a                 # use Anthropic backend
claude-launcher -- --resume        # pass args to claude
```

## First Run

1. Run `claude-launcher`
2. Select backend (Anthropic or OpenRouter)
3. If OpenRouter: login or use existing `OPENROUTER_API_KEY`
4. Pick a model
5. Optionally configure role models (sonnet/opus/haiku)

## Configuration

Settings stored at `~/.config/claude-launcher/config.json`:
- Backend preference
- Selected models (main, sonnet, opus, haiku)
- API key (if logged in via OAuth)

## Environment Variables

- `OPENROUTER_API_KEY` - fallback if not logged in via OAuth

## License

MIT

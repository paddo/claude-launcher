# claude-launcher

Launch Claude Code with multiple backends.

## Install

```bash
npm install -g claude-launcher
# or
npx claude-launcher
```

## Usage

```bash
claude-launcher                    # uses last backend/model
claude-launcher --openrouter       # use OpenRouter
claude-launcher --anthropic        # use Anthropic
claude-launcher -m                 # pick a model
claude-launcher -- --resume        # pass args to claude
```

## Backends

- **anthropic** - standard Claude Code, no changes
- **openrouter** - uses OpenRouter API with model picker

## Requirements

- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed
- `OPENROUTER_API_KEY` env var (for OpenRouter backend)

## Config

Settings stored at `~/.config/claude-launcher/config.json`:
- Selected backend
- Selected model
- Seen models (for new model notifications)

## License

MIT

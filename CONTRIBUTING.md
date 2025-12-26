# Contributing

## Getting Started

```bash
git clone https://github.com/paddo/claude-launcher.git
cd claude-launcher
bun install
```

## Development

```bash
bun dev              # run from source
bun run check        # typecheck + lint
```

## Before Submitting

1. Run `bun run check` - must pass
2. Run `bun run build` - verify build works
3. Update CHANGELOG.md if adding features

## Pull Requests

- Keep changes focused
- Add tests for new features (when test infra exists)
- Update docs if needed

## Reporting Issues

- Check existing issues first
- Include steps to reproduce
- Include version info (`claude-launcher --help`)

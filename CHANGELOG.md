# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/paddo/claude-launcher/compare/v0.1.0-beta.4...HEAD
[0.1.0-beta.4]: https://github.com/paddo/claude-launcher/compare/v0.1.0...v0.1.0-beta.4
[0.1.0]: https://github.com/paddo/claude-launcher/releases/tag/v0.1.0

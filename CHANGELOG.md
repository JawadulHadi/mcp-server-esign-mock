# Changelog

All notable changes to mcp-server-esign-mock. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project has no version tags yet, so
past entries are grouped by merged pull request and date.

Every change adds an entry under **Unreleased** in the same pull request. CI checks this.

## [Unreleased]

### Added
- `CHANGELOG.md` (this file), a pull request template, and a CI job that fails a pull request
  which doesn't update the changelog. Label a PR `skip-changelog` to bypass it.
- README "Changelog and contributing" section.

## PR #2 (2026-10-12)

### Added
- First real `NOTES.md` entries.

## PR #1 (2026-10-12)

### Added
- Architecture diagram in the README, install-from-GitHub instructions for Claude Desktop, MIT license, and CI (typecheck, tests, build).

## Initial commit (2026-10-11)

### Added
- MCP server for a mock e-signature workflow over stdio: template, envelope and status tools, an
  in-memory store, and a human approval gate on sending or cancelling an envelope.

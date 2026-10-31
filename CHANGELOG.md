# Changelog

All notable changes to mcp-catalog-snap. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses semantic versioning once past 0.x.

## [0.1.0] — 2026-10-31

First public release.

### Added

- `snapshot`: capture `tools/list`, `prompts/list` and
  `resources/templates/list` from a stdio (`-- cmd args`) or Streamable HTTP
  (`--url`, `--header`) MCP server into `.mcp-catalog/<server>.json` —
  RFC 8785 key order, sorted entries, every field the server returned, plus
  a header with server name/version, negotiated `protocolVersion`, capture
  time and the sha256 of the canonical catalog body.
- `check`: re-capture and diff against the snapshot(s); readable diff with
  JSON-Pointer paths, description-only changes flagged separately;
  `--ignore-descriptions`, `--allow-additions`, `--json`, `--report FILE`,
  `--update`; exit 1 on drift, 2 on error.
- `diff A.json B.json` and `hash [FILE | target]`.
- `.mcp-catalog.json` config with `${VAR}` expansion so `check` with no
  arguments covers every server.
- Composite GitHub Action (`action.yml`) with `servers-config`,
  `ignore-descriptions`, `allow-additions`, `server`, `timeout-ms` inputs
  and a `drift` output; writes the diff to the step summary.
- Programmatic API (`capture`, `captureFromTransport`, `buildSnapshot`,
  `diffCatalogs`, `evaluate`, `renderDiff`, …).
- `examples/`: committed snapshots of kronicle-lite 0.2.0 and sea-lite 0.1.1,
  checked by the test suite and by this repo's CI through the action.

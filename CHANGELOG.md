# Changelog

All notable changes to mcp-catalog-snap. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses semantic versioning once past 0.x.

## [Unreleased]

### Added

- Size metrics (programmatic API): `measureTool` gives bytes and token counts
  per field (`name`, `title`, `description`, `inputSchema`, `outputSchema`,
  `annotations`) and for the whole entry's canonical JSON. Per-tool
  fingerprints: `fingerprint` is the contract (sha256 of JCS
  `{inputSchema, outputSchema}`), so a wording edit does not move it;
  `descriptionFingerprint` hashes the description separately so wording
  drift is visible on its own; `entryFingerprint` covers every field.
- Pluggable tokenizers: `cl100k` (tiktoken cl100k_base via `js-tiktoken`,
  the reference scale), `o200k`, the `chars4` heuristic, and
  `registerTokenizer` for your own. Every count carries its tokenizer label.
- `orderedToolsFingerprint`: sha256 over the tools array in server order,
  identical to IsoKron ADR-0005's `hashMcpToolDefinitions`. The catalog
  fingerprint (`sha256` in snapshots) is unchanged.
- `anthropicToolCounts`: optional provider-reported counts from Anthropic's
  `count_tokens` endpoint (per-tool marginal and whole catalog).
- Findings engine (`analyzeTool`, `analyzeCallResult`, `summarizeFindings`),
  dependency-free. Rules: `schema-missing`, `schema-invalid` (bad `type`
  names, draft-03 boolean `required`, uncompilable `pattern`, dangling
  `$ref`, root not `object`), `required-not-in-properties`,
  `default-invalid`, `enum-large` (enum/const-union over a cap, default 20),
  `description-repeats-enum` and `enum-in-prose` (DRF-style
  ``* `x` - x`` lists), `duplicate-subtree` (repeated bytes, % of schema,
  top offenders, `$defs/$ref` rewrite estimate), `escaped-json`,
  `untyped-node`, `description-oversize` (descriptions are treated as
  untrusted text: size-capped, never executed; regexes from schemas run only
  when they cannot backtrack catastrophically), `oversize-tool`, `annotations-missing`,
  `annotation-contradiction` (e.g. a `delete` tool with
  `destructiveHint: false`), `output-duplication-risk` and, for observed
  call results, `structured-content-duplicated`.

## [0.1.1] — 2026-11-01

### Fixed

- A snapshot whose stored `sha256` does not match its `catalog` body is now
  refused instead of compared with a warning. `check`, `diff` and
  `hash FILE` exit **3** (new code: snapshot failed its integrity check;
  takes precedence over 2 and 1), print nothing on stdout for `hash`, and
  `check --update` leaves the file alone. The JSON report marks the server
  `"tampered": true`. The action fails the job with its own summary and
  annotation. There is deliberately no flag to waive it: restore the file
  or re-capture it with `snapshot`.
- `--allow-additions` no longer waives additions to a section the snapshot
  lists as empty. Before, a snapshot whose `tools` were emptied passed
  `check --allow-additions` because every live tool counted as an
  "addition", so the check verified nothing. Additions are now waived only
  against a non-empty baseline; an empty section that the live server fills
  is drift, with a reason saying so. (A server gaining its very first prompt
  or resource template under `--allow-additions` therefore needs a
  re-snapshot.)

### Added

- `EXIT_TAMPERED` and `SnapshotIntegrityError` in the programmatic API;
  `ServerResult.tampered`.

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

# Changelog

All notable changes to mcp-catalog-snap. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses semantic versioning once past 0.x.

## [Unreleased]

### Added

- **`sweep` command: the free static sweep.** Input: a live stdio or
  Streamable HTTP server, `--from FILE` (tools/list result, JSON-RPC
  response, tools array, snapshot, or an exec JSONL dump), `--adapter
  tools-list|posthog-exec`. Output: a versioned JSON report
  (`mcp-catalog-snap/sweep/1`, byte-identical for the same input, no
  timestamps) and a markdown summary (stdout, `--md FILE`; `--json`,
  `--report FILE`). Budgets: `--max-tool-tokens`, `--max-catalog-tokens`;
  **exit 4** when exceeded (exits 0–3 unchanged). Also `--tokenizers`,
  `--budget-tokenizer`, `--enum-max`, `--max-description-bytes`,
  `--anthropic` (opt-in), `--call-results`, `--save-raw`, `--top`.
- `--bearer-file FILE` / `--bearer-env VAR` for every `--url` command (an
  error for stdio and config targets, which take `--env` / `headers`).
  Credentials are scrubbed centrally from everything any command prints or
  writes (stdout, stderr, `--report`, `--md`), including text a server
  echoes back; a catalog that embeds the request's credential is refused
  rather than written to a snapshot, `check --update` or `--save-raw`.
  Credential-looking URL path segments are masked in report sources.

### Changed

- Tokenizer backend is `gpt-tokenizer` (same cl100k/o200k counts, verified
  against Python tiktoken; linear on hostile input) instead of
  `js-tiktoken`, whose BPE took minutes on one long word. Texts over 2,048
  units are counted in chunks cut at pre-tokenizer piece boundaries, so the
  counts stay exact.
- Canonical JSON, key sorting, pretty printing and the diff are iterative:
  any nesting depth works, and `__proto__` / `constructor` keys stay data.
  Output is byte-identical to v0.1 for every catalog v0.1 could handle
  (`canonicalize` is now only a test oracle). A tool or property named
  after an `Object.prototype` member no longer crashes anything.

### Security

- Schemas are untrusted: `pattern` is never executed (a default whose check
  needs one is reported as `default-unchecked`), `$ref` expansion has a step
  budget and a cycle guard, malformed `$ref` encodings are findings, walks
  stop at 64 levels (`schema-too-deep`), and each tool's analysis has a
  deterministic work budget (`analysis-budget-exceeded`) instead of a wall
  clock, so reports stay byte-identical.
- Exec adapters only send names matching `[A-Za-z0-9._:-]`, and report
  rejected names (`isError`) separately from transport or timeout failures.
- Markdown output escapes server text and breaks autolinks and @-mentions.
- `runSweep`, `serializeReport`, `renderSweepMarkdown`, `cmdSweep`,
  `EXIT_BUDGET` in the programmatic API.

- Size metrics (programmatic API): `measureTool` gives bytes and token counts
  per field (`name`, `title`, `description`, `inputSchema`, `outputSchema`,
  `annotations`) and for the whole entry's canonical JSON. Per-tool
  fingerprints: `fingerprint` is the contract (sha256 of JCS
  `{inputSchema, outputSchema}`), so a wording edit does not move it;
  `descriptionFingerprint` hashes the description separately so wording
  drift is visible on its own; `entryFingerprint` covers every field.
- Pluggable tokenizers: `cl100k` (tiktoken cl100k_base, the reference
  scale), `o200k`, the `chars4` heuristic, and
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
  untrusted text: size-capped, never executed), `oversize-tool`,
  `oversize-catalog`, `default-unchecked`, `schema-too-deep`,
  `analysis-budget-exceeded`, `annotations-missing`,
  `annotation-contradiction` (e.g. a `delete` tool with
  `destructiveHint: false`), `output-duplication-risk` and, for observed
  call results, `structured-content-duplicated`.
- Adapters (`loadSweepInput`): `tools-list` for plain servers (live stdio /
  Streamable HTTP, or a saved tools/list result, JSON-RPC response, tools
  array or snapshot file) and `posthog-exec` for exec/CLI-style servers
  (one `exec` tool with `tools` / `info` / `schema`). The exec adapter runs
  read-only commands only, measures `info` output as the exposure, keeps the
  `info --json` / `schema` views, accounts for the schema embedded as an
  escaped string, and can save what it fetched (`serializeExecRecords`) for
  an offline, byte-identical re-run. `ExecProfile` describes other
  exec-style servers. Report sources never carry credentials (URL origin and
  path only; stdio command basename only).
- On the first PostHog audit's saved dump (not committed; opt-in test
  `MCS_POSTHOG_RAW=…`) the totals match the audit: 1,193 tools, 933,010
  cl100k tokens of `info` output over the full catalog, 1,290,802
  unsummarized, 249,001 `schema`, 210,494 descriptions, escaped vs plain
  schema 660,351 vs 606,160. What CI checks is tokenizer parity with Python
  tiktoken on committed fixtures (cl100k and o200k oracle values).

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

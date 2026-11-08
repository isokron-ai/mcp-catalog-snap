# Changelog

All notable changes to mcp-catalog-snap. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses semantic versioning once past 0.x.

## [Unreleased]

### Added

- **Wire bytes vs model-visible tokens (#7).** The sweep reports two
  separate measures per tool and in totals: `wire` (canonical JSON of the
  whole `tools/list` entry, icons and `_meta` included) and `modelVisible`
  (canonical JSON of `name`, `title`, `description`, `inputSchema`).
  Budgets, `modelVisiblePerTool`, the `modelVisibleTokens` histogram and
  the largest-tools table use model-visible tokens. `annotations` are not
  model-visible unless `--count-annotations` is given;
  `measurement.modelVisibleFields` and `measurement.budgetsApplyTo` record
  the choice. Before this, the single `exposure` figure counted base64
  `icons`, overstating what the model sees about 5x on github-mcp-server
  v2.1.0 (119,633 vs 22,347 cl100k tokens). `exposure`, `exposurePerTool`
  and `histograms.exposureTokens` are gone (the `sweep/1` format has not
  been released yet, so the format id is unchanged).
- Per-field breakdown adds `icons`, `_meta` and `other` (every field not
  broken out), next to `outputSchema`.
- Findings `icon-data-uri-large` (a `data:` URI icon over
  `--max-icon-bytes`, default 4096) and `icon-data-uri-duplicated` (the
  same `data:` URI repeated across the catalog; github-mcp-server v2.1.0
  sends 182 copies of 48 images).

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
  Credentials are scrubbed from the report and diff *models* before any
  renderer formats them, and again at the output layer for everything any
  command prints or writes (stdout, stderr, `--report`, `--md`), matching
  raw, markdown-escaped, JSON-pointer-escaped, JSON-escaped, percent-encoded
  and base64/base64url forms, and masking a 6+ character fragment of a
  secret at any `…` cut. A catalog that embeds the request's credential is
  refused rather than written to a snapshot, `check --update` or
  `--save-raw`. Credential headers shorter than 8 characters are refused
  (they cannot be scrubbed without masking ordinary text). Credential-looking
  URL path segments are masked in report sources.

### Changed

- `package.json` is `0.2.0-dev`, so the report `generator`, the snapshot
  `capturedWith` and `--version` no longer claim 0.1.1 for unreleased
  0.2 code; a test keeps the version ahead of the last released one while
  `[Unreleased]` has entries.

- Tokenizer backend is `gpt-tokenizer` (same cl100k/o200k counts, verified
  against Python tiktoken; linear on hostile input) instead of
  `js-tiktoken`, whose BPE took minutes on one long word. Texts over 2,048
  units are counted in chunks cut only at pre-tokenizer piece boundaries (a
  long boundary-free word stays whole), so counts are exact, never
  approximate; adversarial long runs of letters, digits and hex,
  contractions at chunk edges and combining marks are oracle fixtures.
- Canonical JSON, key sorting, pretty printing and the diff are iterative:
  any nesting depth works, and `__proto__` / `constructor` keys stay data.
  Output is byte-identical to v0.1 for every catalog v0.1 could handle
  (`canonicalize` is now only a test oracle). A tool or property named
  after an `Object.prototype` member no longer crashes anything.

### Security

- Server text printed to a terminal or CI log is neutralized. `check`
  printed tool names and property paths raw: a name containing a newline
  injected GitHub Actions workflow commands (`::warning::`,
  `::add-mask::`) into the job log and could close the step-summary code
  fence, and ESC/BEL sequences reached the terminal. Markdown code spans
  passed ESC/BEL/NUL through, and server error messages went to stderr raw
  and unbounded. Now names, paths, reasons and the snapshot header write
  controls, line separators and bidi controls as escapes; markdown drops
  them; every `error:` line is one line, escaped, at most 1,000 chars.

- Live capture is bounded (every command that talks to a server): a list
  stops after 1,000 pages or 64 MiB across pages (a server that returned a
  fresh `nextCursor` forever hung every command with memory growing); one
  message may be at most 10 MiB on Streamable HTTP too (bodies were
  unbounded: an endless response grew ~140 MB/s until the timeout), cut by
  Content-Length or while streaming, with the download cancelled; an
  oversize stdio message now says so instead of "Connection closed"; a live
  exec sweep refuses a `tools` listing of more than 2,000 names.

- Schemas are untrusted: `pattern` is never executed (a default whose check
  needs one is reported as `default-unchecked`), default validation has a
  step budget (one step per comparison) and a byte budget (each value
  serialized once, enum membership via a set built once per enum), `$ref`
  results are memoized per (target, value) behind a cycle guard, malformed `$ref` encodings are findings, walks
  stop at 64 levels (`schema-too-deep`), and each tool's analysis has a
  deterministic work budget (`analysis-budget-exceeded`) instead of a wall
  clock, so reports stay byte-identical.
- Exec adapters only send names matching `[A-Za-z0-9._:-]`, and report
  rejected names (`isError`) separately from transport or timeout failures.
- Markdown output escapes server text (including `&`, so entities cannot
  spell a mention, link or tag) and breaks autolinks and @-mentions.
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

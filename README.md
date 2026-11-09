# mcp-catalog-snap

**Snapshot an MCP server's tool catalog. Fail CI when it drifts.**

`mcp-catalog-snap` connects to an MCP server, pulls `tools/list`,
`prompts/list` and `resources/templates/list`, writes them as canonical JSON
(RFC 8785) with a sha256 fingerprint, and later re-captures and diffs. Any
byte that changed — a schema field, an annotation, a reworded description —
is reported with its JSON path, and the exit code is 1.

`mcp-catalog-snap sweep` is the free static sweep: model-visible tokens
and wire bytes per tool, per-tool contract fingerprints, and schema findings
(enum blowups, duplicated subtrees, untyped fields, invalid schemas,
annotation contradictions…) as a versioned JSON report plus a markdown
summary. See [Static sweep](#static-sweep).

## Why

Every model request carries the tool definitions. Two things depend on
those bytes being stable:

1. **Prompt-cache prefix.** Anthropic prompt caching is a strict prefix cache
   (system → tool definitions → context → history). The tool block is
   written once and read back at a fraction of the price for the rest of the
   session. Change one byte in one description and the whole block is
   re-billed — for every client, on every request, until the cache re-warms.
   Nothing tells you this happened; your cache-hit rate just sags.
2. **Agent behavior.** The model plans from the catalog. A tightened
   `required`, a flipped `destructiveHint`, a renamed parameter, a sentence
   added to a description: each changes what the model will do, silently,
   with no code path in your agent to diff against.

Most MCP servers generate their catalog from code (Zod → JSON Schema), so a
dependency bump, a converter upgrade or a well-meant docstring edit can
change the emitted bytes without anyone touching "the tools". This tool
makes the catalog a reviewed artifact: it lives in git, it has a
fingerprint, and a change to it shows up in a PR as a diff you can read.

## 60-second usage

Requires Node ≥ 20.

```sh
# 1. snapshot a stdio server (everything after `--` is the server command)
npx mcp-catalog-snap snapshot -- npx -y kronicle-lite serve
#    → .mcp-catalog/kronicle-lite.json

#    or a Streamable HTTP server
npx mcp-catalog-snap snapshot --url https://host/mcp --header "Authorization: Bearer $TOKEN"

# 2. commit .mcp-catalog/

# 3. later / in CI: re-capture and compare
npx mcp-catalog-snap check -- npx -y kronicle-lite serve
#    exit 0 = identical, 1 = drift, 2 = could not check,
#         3 = snapshot failed its sha256 integrity check
```

For more than one server, list them in `.mcp-catalog.json` and run
`check` with no arguments:

```json
{
  "snapshotDir": ".mcp-catalog",
  "servers": [
    { "name": "kronicle-lite", "command": ["npx", "-y", "kronicle-lite@0.2.0", "serve"] },
    { "name": "sea-lite",      "command": ["npx", "-y", "sea-lite@0.1.1", "serve"] },
    { "name": "api",           "url": "https://api.example.com/mcp",
                               "headers": { "Authorization": "Bearer ${MCP_TOKEN}" } }
  ]
}
```

`${VAR}` is expanded from the environment at load time and a missing
variable is an error, so a forgotten CI secret fails loudly instead of
sending the literal string. Entries also accept `args`, `env` and `cwd`.

## Commands

| command | does |
| --- | --- |
| `snapshot [-- cmd …] [--url U]` | capture → `.mcp-catalog/<server>.json` (`--name`, `--dir`, `--no-write`) |
| `check [--server N] [--ignore-descriptions] [--allow-additions] [--json] [--update] [--report F]` | re-capture, diff, exit 1 on drift |
| `diff A.json B.json [--json]` | diff two snapshot files |
| `hash [FILE \| -- cmd … \| --url U]` | print the catalog fingerprint (sha256) |
| `sweep [--from F \| -- cmd … \| --url U] [--json] [--report F] [--md F]` | static sweep report; exit 4 over budget |

`--url` targets take `--bearer-file FILE` (first line) or `--bearer-env VAR`
for `Authorization: Bearer …` (stdio servers: `--env`; config files:
`"headers"` with `${VAR}`). The token is never printed or written by any
command; see [Credentials](#static-sweep).

Policy flags:

- `--ignore-descriptions` — a change whose only differing paths end in
  `description` (top-level *or* nested in a JSON Schema property) is
  reported but not counted as drift. The bytes still changed, so the
  cache prefix still changed; the output says so.
- `--allow-additions` — new tools / prompts / templates are not drift.
  Removals and changes to existing entries always are. An addition is an
  entry beyond a baseline the snapshot actually holds: when the snapshot
  lists *no* entries in a section (say, `"tools": []`) and the live server
  lists some, that section was never checked, so its additions still count
  as drift. Re-snapshot if the server really gained its first prompt.

Every command that reads a snapshot file (`check`, `diff`, `hash FILE`)
first recomputes the sha256 of its `catalog` and compares it with the
stored `sha256`. A mismatch means the file was edited by hand or corrupted;
it is refused with **exit 3** before anything is compared (no policy flag
waives it, and `check --update` does not overwrite it). Restore the file
from git, or re-capture it with `snapshot` and review the diff. The hash is
an integrity check, not a signature: someone who edits the catalog *and*
recomputes `sha256` produces a valid file, which is why snapshot changes
belong in code review.

## Static sweep

```sh
# a live server (stdio or Streamable HTTP)
mcp-catalog-snap sweep -- npx -y kronicle-lite serve
mcp-catalog-snap sweep --url https://mcp.example.com/mcp --bearer-env EXAMPLE_TOKEN

# offline: a saved tools/list result, JSON-RPC response, tools array or snapshot file
mcp-catalog-snap sweep --from tools.json --report sweep.json --md sweep.md

# an exec/CLI-style server (one `exec` tool with tools / info / schema commands)
mcp-catalog-snap sweep --adapter posthog-exec --url "$POSTHOG_MCP_URL" \
  --bearer-file ~/.posthog-key --save-raw posthog.jsonl
mcp-catalog-snap sweep --adapter posthog-exec --from posthog.jsonl   # byte-identical re-run

# CI: fail when any tool is over 4,000 model-visible tokens or the catalog over 60,000
mcp-catalog-snap sweep --from tools.json --max-tool-tokens 4000 --max-catalog-tokens 60000
```

stdout is the markdown summary (`--json` prints the JSON report instead).

**What a number means.** Each tool gets two separate measures:

- **model-visible**: what the model reads. The canonical JSON of only the
  fields clients pass to the model: `name`, `description`, `inputSchema`
  (Anthropic's tool definition: `name`, `description`, `input_schema`). **Budgets, the per-tool distribution, the histogram and
  the largest-tools ranking use this.**
- **wire**: what crosses the wire. The canonical JSON of the whole
  `tools/list` entry, including `icons` (often base64 `data:` URIs),
  `_meta`, `outputSchema` and `annotations`. Clients do not forward these
  to the model, so wire size is a transport cost, not a context cost: on
  github-mcp-server v2.1.0 (91 tools) wire is 119,633 cl100k tokens and
  model-visible 22,347, because the icons are 145 KB of the 260 KB.

`annotations` are **not** model-visible by default: they are hints a client
uses for permissions and UI (Anthropic's tool definition is `name`,
`description`, `input_schema`). `--count-annotations` counts them as
model-visible when your client does forward them; the report records the
choice in `measurement.modelVisibleFields`. `title` is a display name for
UIs and is not counted (it is in the per-field breakdown and in wire). Both measures are
reference texts: clients re-serialize definitions their own way.

Every figure is catalog-wide: each tool counted once, as if the whole
catalog were loaded. It is not session exposure (what one client loaded)
or task exposure (what an agent pulled). `cl100k` (tiktoken cl100k_base)
is a reference scale for comparing servers, not a Claude tokenizer; every
count carries its tokenizer label.

| measured | how |
| --- | --- |
| model-visible | `tools-list`: RFC 8785 canonical JSON of `{name, description, inputSchema}` (+ `annotations` with `--count-annotations`). Exec adapters: the `info <tool>` output text the wrapper returns |
| wire | `tools-list`: RFC 8785 canonical JSON of the whole `tools/list` entry. Exec adapters: the same `info` text |
| fields | `name`, `title`, `description` (raw text), `inputSchema`, `outputSchema`, `annotations`, `icons`, `_meta` (canonical JSON), `other` (every remaining field together) |
| views | exec adapters: unsummarized `info`, `info --json`, `schema` outputs |
| embedded schema | exec adapters: the schema as an escaped string inside `info` vs as plain JSON |
| tokenizers | `--tokenizers cl100k,o200k,chars4` (default `cl100k`; `chars4` = `ceil(chars/4)`, the heuristic some servers use for limits) |
| provider count | `--anthropic`: Anthropic `count_tokens` per tool and for the whole catalog. Opt-in because it sends the catalog to a third party; skipped with a note when `ANTHROPIC_API_KEY` is unset |

**Fingerprints.**

- `fingerprints.catalog`: the snapshot `sha256`, unchanged from v0.1
  (sha256 of canonical JSON over sorted `{tools, prompts, resourceTemplates}`).
  A tools-only input (tools/list file, exec adapter) hashes empty prompts
  and templates.
- `fingerprints.toolsOrdered`: sha256 of canonical JSON over the tools
  array **in server order**. This is IsoKron ADR-0005's
  `hashMcpToolDefinitions` (deep key sort, array order kept), so the two
  agree on the same `tools/list`. `null` when the order is unknown
  (snapshot input).
- per tool: `fingerprint` = sha256 of canonical `{inputSchema, outputSchema}`
  (the contract: a wording edit does not move it, so proxy rule packs
  pinned to it survive), `descriptionFingerprint` (wording drift on its own),
  `entryFingerprint` (every field).

**Findings** (stable rule ids; `error` / `warn` / `info`):

| rule | fires on |
| --- | --- |
| `schema-missing`, `schema-invalid` | no `inputSchema`; root not `type: "object"`; bad `type` names (`"unknown"`), draft-03 boolean `required`, uncompilable `pattern`, dangling `$ref`, malformed keywords |
| `required-not-in-properties` | `required` names an undefined property (error when `additionalProperties: false`) |
| `default-invalid`, `default-unchecked` | a `default` that fails its own schema; or one that could not be fully checked (its `pattern` is never executed, or the validation budget ran out) |
| `enum-large` | enum / const-union over `--enum-max` values (default 20); sizes also go in a histogram |
| `description-repeats-enum`, `enum-in-prose` | DRF-style ``* `x` - x`` lists that restate an enum, or list values with no enum to enforce them |
| `duplicate-subtree` | repeated subtrees ≥ 200 bytes: waste bytes, % of schema, top offenders, `$defs/$ref` rewrite estimate |
| `escaped-json` | JSON carried inside a string (a default, or the exec `info` payload) |
| `untyped-node` | `{}` nodes, `items: {}`, opaque objects; exec `schema` views with `type: "unknown"` |
| `description-oversize` | a description over `--max-description-bytes` (default 16384) |
| `oversize-tool`, `oversize-catalog` | model-visible tokens over the budget (advisory 5,000 per tool when no budget is set) |
| `icon-data-uri-large`, `icon-data-uri-duplicated` | a `data:` URI icon over `--max-icon-bytes` (default 4096); the same `data:` URI sent more than once in one `tools/list` (one catalog-level finding with copies, unique images and repeated bytes) |
| `schema-too-deep`, `analysis-budget-exceeded` | nesting past 64 levels, or a tool past its deterministic work budget: the rest of that tool is not analyzed |
| `annotations-missing`, `annotation-contradiction` | no `readOnlyHint`/`destructiveHint`; a `delete`/`remove`/… tool with `destructiveHint: false` or `readOnlyHint: true`; both hints true |
| `output-duplication-risk`, `structured-content-duplicated` | `outputSchema` declared (results may repeat `structuredContent` as text); with `--call-results FILE` (JSONL `{"tool","result"}`), observed duplication |

**Report** (`--report FILE` / `--json`): `format: "mcp-catalog-snap/sweep/1"`,
then `server`, `source` (URL origin + path, or the stdio command basename:
never credentials), `measurement` (what `wire` and `modelVisible` mean,
`modelVisibleFields`, `budgetsApplyTo`), `fingerprints`, `totals`, `histograms`,
`budget`, `anthropic`, `findingsSummary`, `tools[]`, `findings[]`, `notes`.
The output is deterministic: no timestamps, tools and findings sorted, so
the same input gives a byte-identical report. Additive fields keep the
format; a rename or removal bumps it.

**Untrusted input.** Tool names, descriptions and schemas are data from the
server. Nothing from them is executed: schema `pattern`s are never run
(JS regexes cannot be time-boxed), default validation is budgeted in steps
and bytes, `$ref` expansion is memoized and cycle-guarded, walks stop at
64 levels, serialization is iterative (any depth), every tool's analysis has a deterministic work budget, names like
`__proto__` stay data, exec adapters send only `[A-Za-z0-9._:-]` names,
descriptions over the cap are flagged, strings over 1 MiB are measured but
not scanned, tokenization is linear and exact, and markdown output escapes
server text (entities included) and breaks autolinks and @-mentions.

**Credentials.** Bearer tokens and other credential headers (and
credential-looking `--env` values of 8+ characters for stdio children) are
scrubbed from the report and diff data before anything is formatted, and
again from everything any command prints or writes, in raw, markdown,
JSON-pointer, JSON, percent-encoded and base64 forms, including text the
server echoes back. A catalog that embeds the request's credential is
refused rather than written to a snapshot or raw dump. Credential headers
shorter than 8 characters are refused. Report sources keep only the URL origin
and path, with credential-looking path segments masked.

Exit codes: **0** swept, within budget · **2** error · **3** `--from`
snapshot failed its integrity check · **4** an explicit budget was exceeded.

## Output

`check` against a snapshot whose `get_system_state` description was edited:

```
== kronicle-lite (.mcp-catalog/kronicle-lite.json)
fingerprint snapshot: b551549b689d49130ff31ea36bdae884606e7992e95f87329b823ccd91b64f81
fingerprint live:     38506578bae09476f1d2b2a6722b35a9cc5b3925013d765b1ed4cac21ecab698

tools: 9 -> 9 (+0 added, -0 removed, ~1 changed)
  ~ get_system_state  [description-only]
      /description (description)
        - … returned cursor forward (now with a drift banner)."
        + … returned cursor forward."

DRIFT: 1 reason(s)
  tool description changed: get_system_state (/description)

1/1 server(s) drifted
```

A schema change reads the same way, with the path that moved:

```
  ~ put_document
      /inputSchema/properties/slug/maxLength
        - 200
        + 120
      /inputSchema/required/1
        - "title"
        + <absent>
```

`--json` emits a report (`ok`, per-server `fingerprint`, structural `diff`,
`verdict.reasons`) for machines.

## Snapshot format

```json
{
  "capturedAt": "2026-10-31T23:01:48.036Z",
  "capturedWith": "mcp-catalog-snap/0.1.0",
  "catalog": {
    "prompts": [],
    "resourceTemplates": [ { "uriTemplate": "kronicle://docs/{slug}", "...": "..." } ],
    "tools": [ { "name": "audit_assumptions", "description": "...", "inputSchema": { "...": "..." }, "annotations": { "...": "..." } } ]
  },
  "format": "mcp-catalog-snap/1",
  "protocolVersion": "2025-11-25",
  "server": { "name": "kronicle-lite", "version": "0.2.0" },
  "sha256": "38506578bae09476f1d2b2a6722b35a9cc5b3925013d765b1ed4cac21ecab698"
}
```

- Keys are in RFC 8785 order throughout (hence the header fields sorting
  around `catalog`); the file is the canonical form pretty-printed so git
  diffs stay readable.
- `sha256` covers the compact canonical bytes of `catalog` only. A server
  version bump or a new capture time does not change it. Think of it as the
  **cache-prefix fingerprint**: same hash, same tool bytes.
- Tools and prompts are sorted by `name`, resource templates by
  `uriTemplate`. Every field the server returned is kept (`title`,
  `description`, `inputSchema`, `outputSchema`, `annotations`, `_meta`,
  `icons`, anything else); nothing is normalized away.

## CI

### GitHub Action

```yaml
name: mcp-catalog
on: [push, pull_request]
jobs:
  catalog:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: rafe-walker/mcp-catalog-snap@v0.1.1
        with:
          servers-config: .mcp-catalog.json   # default
          # ignore-descriptions: 'true'
          # allow-additions: 'true'
        env:
          MCP_TOKEN: ${{ secrets.MCP_TOKEN }} # if your config uses ${MCP_TOKEN}
```

On drift the job fails, the readable diff goes to the step summary, and the
`drift` output is `"true"`. A snapshot that fails its integrity check
fails the job too (exit 3, `drift` stays `"false"`). The action builds the pinned copy of the CLI
that ships with the tag (no registry lookup at run time).

### Plain shell

```yaml
      - run: npx -y mcp-catalog-snap@0.1.1 check
```

When a change is intended, re-run `snapshot` (or `check --update`) and
commit the new `.mcp-catalog/` file in the same PR; the reviewer sees the
catalog diff next to the code that caused it.

## Programmatic use

```ts
import { capture, buildSnapshot, diffCatalogs, evaluate, parseSnapshot } from 'mcp-catalog-snap';

const live = buildSnapshot(await capture({ kind: 'stdio', command: 'npx', args: ['-y', 'kronicle-lite', 'serve'] }));
const stored = parseSnapshot(await fs.readFile('.mcp-catalog/kronicle-lite.json', 'utf8'));
const diff = diffCatalogs(stored.catalog, live.catalog);
const { drift, reasons } = evaluate(diff, { ignoreDescriptions: true });
```

`captureFromTransport(transport)` accepts any SDK `Transport`, including
`InMemoryTransport` for testing a server in-process.

## Examples

`examples/` carries a config and committed snapshots of two published
servers, checked in this repo's own CI:

| server | tools | fingerprint |
| --- | --- | --- |
| kronicle-lite 0.2.0 | 9 | `38506578bae09476f1d2b2a6722b35a9cc5b3925013d765b1ed4cac21ecab698` |
| sea-lite 0.1.1 | 12 | `9610edb6b384416ddcb8e3f968c5cda3a3eb673b2238d11fe72891ee3e33d3d5` |

## Limitations

- **The fingerprint is of the wire catalog, not of what your client sends
  the model.** Clients reorder, rename (`server__tool`), filter, or
  reformat tool definitions before they reach the API. Two servers with the
  same fingerprint produce the same bytes *into* the client; whether the
  client preserves that is the client's business. Treat the hash as a
  necessary condition for a stable prefix, not a sufficient one.
- `tools/list` is captured once per run with a fresh session. Servers whose
  catalog depends on auth scope, session state or feature flags will
  snapshot whatever that session saw; capture with the same credentials you
  check with.
- `notifications/tools/list_changed` is not watched. This is a point-in-time
  capture tool, not a monitor.
- Streamable HTTP only, for remote servers. The deprecated HTTP+SSE
  transport is not supported; put such servers behind a stdio bridge.
- Capture is bounded because the server is untrusted: one message (stdio
  line or HTTP response body) may be at most 10 MiB, one list at most 1,000
  pages and 64 MiB across them, and every request times out (`--timeout`,
  default 30 s). `--timeout-total MS` bounds each server's whole capture
  (default: none, so a slow but valid server can take up to pages ×
  `--timeout`). A live exec sweep queries at most 2,000 listed names.
  Past a cap the command fails with exit 2 and says which cap it hit.
- A stdio server runs in its own process group, and every close (normal
  end, error, deadline, Ctrl-C) ends the whole group: stdin closed, then
  SIGTERM, then SIGKILL after 2 s. Wrappers (`npx`, `uvx`, `bash -c`,
  `sh -c "x & exec y"`) leave no processes behind, and the server's
  stderr is forwarded through a pipe the CLI closes, so even a process
  that escaped the group (`setsid`) cannot keep the CLI from exiting. On
  Windows the tree is ended with `taskkill /T /F` (not covered by CI).

  | cap | value |
  | --- | --- |
  | one server message (stdio line / HTTP body) | 10 MiB |
  | pages per list | 1,000 |
  | one list across pages | 64 MiB |
  | per request | `--timeout`, default 30,000 ms |
  | whole capture | `--timeout-total` (action: `timeout-total-ms`), default none |
  | live exec names | 2,000 |
- Pagination is followed to exhaustion (within those caps), but a server that emits a
  non-deterministic order across pages still ends up sorted, so order
  changes are invisible by design (clients do not promise to preserve order
  either).
- The sweep is static. It reads the catalog only (exec adapters run
  read-only `tools` / `info` / `schema` commands, never `call`), so it says
  nothing about response sizes, errors or task success.
- Model-visible is a field projection, not a client trace. A tool that an
  MCP Apps host hides from the model (`_meta.ui.visibility: ["app"]`) is
  still counted, and a client that forwards more (annotations: use
  `--count-annotations`) or less than the projected fields differs from it.
- The exec adapter's live mode trusts `info --json` for the contract; a
  server that summarizes large schemas there yields summarized contracts.
  Offline dumps that carry `full_schema` do not have this limit.
- Resource *instances* (`resources/list`) are not captured — they are data,
  not catalog. Resource templates are.

## Contributing

See `CONTRIBUTING.md` (DCO sign-off, Apache-2.0).

---

Part of [IsoKron](https://isokron.ai) — typed-graph substrate for AI agents.

Built off-grid in Cochise County, AZ by a laid-off support engineer — https://theexiledentrepreneur.com

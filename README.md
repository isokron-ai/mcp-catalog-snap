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

Requires Node ≥ 20. To run from a clone instead of npm, install with
`npm ci` (the pinned lockfile), not `npm install`, then `npm run build`.

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
| `snapshot [-- cmd …] [--url U]` | capture → `.mcp-catalog/<server>.json` (`--name`, `--label`, `--dir`, `--no-write`) |
| `check [--server N] [--ignore-descriptions] [--allow-additions [--allow-write-additions]] [--json] [--update] [--report F]` | re-capture, diff, exit 1 on drift |
| `diff A.json B.json [--json]` | diff two snapshot files |
| `hash [FILE \| -- cmd … \| --url U]` | print the catalog fingerprint (sha256) |
| `matrix --flag-sets F [-- cmd … \| --url U \| --server N]` | one snapshot per flag set + which tools, annotations and schemas differ between sets (see [Flag matrix](#flag-matrix)) |
| `sweep [--from F \| -- cmd … \| --url U] [--json] [--report F] [--md F]` | static sweep report; exit 4 over budget |

Options are strict: an option the command does not take (a typo such as
`--max-tool-token`) is an error (exit 2) that names the closest one, a
single-value option may be given once, numbers are plain decimal integers,
a stray positional argument is an error (`hash` takes one file, `diff`
two, the others none), and input files (`--from`, snapshots, config,
`--call-results`, `--bearer-file`) are read up to 64 MiB (64 KiB for a
bearer file). Pipes such as `--from <(…)` or `/dev/stdin` work but must
deliver their input within 30 s; a named FIFO gets 5 s for a writer and
then fails instead of hanging; a UTF-8 BOM is ignored. `snapshot` writes a
file that would be larger than the 64 MiB that `check`, `diff` and `hash`
read in a more compact form (see [Snapshot format](#snapshot-format)), and
refuses, before writing, one that is over it even as compact JSON.

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
  It waives only added tools with `readOnlyHint: true`: an added tool that
  can write still drifts unless `--allow-write-additions` is given too.
- **Tool safety.** Every added tool is classified from its annotations
  (MCP defaults: not read-only unless `readOnlyHint: true`; a non-read-only
  tool is destructive unless `destructiveHint: false`) and marked
  `[read-only]`, `[write]` or `[destructive]`. Added tools that can write,
  and tools whose annotations moved toward write/destructive, are listed
  first as `SAFETY:` lines, are drift reasons of their own, sit in the
  JSON diff under `safety`, and get their own heading and `::error` in the
  Action. This is the shape of a read-only deployment failing open (e.g.
  github-mcp-server issue 3747, `GITHUB_READ_ONLY=yes` ignored): the
  snapshot holds the read tools and the live server lists write tools too.
  A tool that declares both `readOnlyHint: true` and `destructiveHint:
  true` is classified read-only (the spec only reads `destructiveHint` when
  `readOnlyHint` is false); `snapshot` and `check` print a `warning:` line
  on stderr for it, since one of the two hints is wrong.

Every command that reads a snapshot file (`check`, `diff`, `hash FILE`)
first recomputes the sha256 of its `catalog` and compares it with the
stored `sha256`. A mismatch means the file was edited by hand or corrupted;
it is refused with **exit 3** before anything is compared (no policy flag
waives it, and `check --update` does not overwrite it). Restore the file
from git, or re-capture it with `snapshot` and review the diff. The hash is
an integrity check, not a signature: someone who edits the catalog *and*
recomputes `sha256` produces a valid file, which is why snapshot changes
belong in code review.

## Flag matrix

Many servers list different tools depending on how they are started:
`--read-only` drops write tools, a toolset flag adds a group, a
"destructive" switch removes tools or swaps one for a narrower tool *under
the same name*. A snapshot shows one of those catalogs. `matrix` takes a
list of flag sets, captures the server once per set in one run (one launch
per set, one after the other), and reports what changes between them.

```sh
cat > k8s-sets.json <<'EOF'
[
  { "name": "default" },
  { "name": "read-only",      "args": ["--read-only"] },
  { "name": "no-destructive", "args": ["--disable-destructive"] },
  { "name": "all-toolsets",   "args": ["--toolsets", "core,config,helm"] }
]
EOF
mcp-catalog-snap matrix --flag-sets k8s-sets.json -- npx -y kubernetes-mcp-server@<version>
```

- A set is `{"name", "args"?, "env"?, "headers"?}`. `args` are appended to
  the server's command line and `env` is layered on its environment (stdio);
  `headers` are added to an HTTP target's headers (for servers that take
  toolsets or read-only mode as headers). `${VAR}` is expanded as in the
  config file. Names are file names: letters, digits, `.`, `_`, `-`.
- A configured server can carry its sets as `"flagSets": [...]` in
  `.mcp-catalog.json`; then `matrix --server NAME` needs no file.
- Output: `<dir>/<server>.matrix/<set>.json`, an ordinary format-2
  snapshot per set (`check`, `diff` and `hash` read them; `flagSet` and
  `launch` in the header say which set and which arguments), and
  `<dir>/<server>.matrix/_matrix.json` (`mcp-catalog-snap/matrix/1`, no
  timestamps, so the same catalogs give the same bytes). `--no-write`
  prints only; `--json` prints the report.
- The report lists, per section, every tool / prompt / template with the
  sets it appears in and its **variants**: definitions grouped by
  fingerprint and lettered A, B, … in set order, each tool variant with its
  annotations and read-only / write / destructive class, and the JSON paths
  where variant B differs from A. `versusBaseline` compares every set with
  the first (added, removed, changed, and the `SAFETY` view: added tools that
  can write, tools that became less safe).
- Exit 0 when every set was captured; 2 when any failed (the others are
  still written, and the report records the error).

The test fixture `test/fixtures/servers/flags-stdio.mjs` mimics those
flags; its matrix reads:

```
flag matrix: flags-server 0.0.1, 4 flag set(s), 4 captured, baseline "default"
  default         4 tools, 0 prompts, 0 templates  protocol 2025-11-25  sha256 7aab9941…
  read-only       3 tools, 0 prompts, 0 templates  protocol 2025-11-25  sha256 91fa0e80…
  no-destructive  3 tools, 0 prompts, 0 templates  protocol 2025-11-25  sha256 a60bf797…
  all-toolsets    7 tools, 0 prompts, 0 templates  protocol 2025-11-25  sha256 b984076d…

tools: 7 across all sets, 2 identical in every set, 5 differ
  name            default   read-only  no-destructive  all-toolsets
  helm_install    -         -          -               A write
  helm_list       -         -          -               A ro
  helm_uninstall  -         -          -               A destr
  pods_delete     A destr   -          -               A destr
  pods_run        A write   B ro       A write         A write
  pods_run: A -> B: /annotations/destructiveHint, /annotations/readOnlyHint, /description, /inputSchema/properties/namespace

versus baseline "default":
  read-only       tools +0 -1 ~1
  no-destructive  tools +0 -1 ~0
  all-toolsets    tools +3 -0 ~0
    SAFETY: 2 added tool(s) are not read-only (1 destructive): helm_install, helm_uninstall
```

`pods_run` is one registration with two meanings: a writable tool by
default, a read-only dry run under `--read-only`. Without the matrix, a
read-only snapshot would show only the second.

## Telemetry

Some servers report usage by default. Every stdio server catalog-snap
launches (`snapshot`, `check`, `hash`, `sweep`, `matrix`) gets common
opt-out variables: `DO_NOT_TRACK=1`, `OTEL_SDK_DISABLED=true`,
`CHECKPOINT_DISABLE=1`, `HF_HUB_DISABLE_TELEMETRY=1`,
`DOTNET_CLI_TELEMETRY_OPTOUT=1`, `NEXT_TELEMETRY_DISABLED=1`,
`SCARF_ANALYTICS=false` and `ANONYMIZED_TELEMETRY=false`. They override
the inherited environment; the server's own `env` (config `env`, `--env`)
still wins. Add server-specific ones with `--telemetry-env KEY=VALUE`
(repeatable) or config `"telemetryEnv": {"GRAFANA_USAGE_STATS":
"disabled"}`; drop the built-in set with `--no-telemetry-defaults` or
config `"telemetryDefaults": false`. The snapshot records the variables
the child received, with their values, under `launch.telemetryEnv`. HTTP
servers run elsewhere and are not affected.

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

**Whole object vs field sum.** Model-visible tokenizes one JSON object
per tool; the per-field rows tokenize each field on its own (name and
description as raw text, schemas as JSON). The object form pays for keys,
quotes and the description's JSON escaping, and tokens merge across field
boundaries, so the two differ: on github-mcp-server v2.1.0, 22,347
(object) vs 21,538 (field sum). The report carries both
(`totals.modelVisible`, `totals.modelVisibleFieldSum`); budgets use the
object figure.

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
Every command prints server text (tool names, paths, server name and
version, error messages) with control characters, line breaks, bidi
controls and invisible format characters (zero-width, word joiner, soft
hyphen, BOM) written as escapes (`\n`, `\u001b`, `\u200b`); markdown
drops them. On top of that, every line the CLI prints passes one output
boundary: terminal-active characters become escapes, every `##[` (the
runner's legacy command form, honored anywhere in a line) becomes
`#\u0023[`, and a line that would start with a workflow command (`::`,
after any spaces or invisible characters) or a code fence gets a leading
`\`, so no server string (or snapshot file name) can inject into a CI log,
stop the runner's command processing, close the action's step-summary
fence, or drive the terminal. Every JSON the CLI prints or writes
(`--json`, `--no-write`, snapshot files, reports, raw dumps) writes C1,
U+2028/9, bidi and invisible characters and `##[` as `\u` escapes: the
same values, nothing hidden from a human reading the file or a diff. Error messages are
one line of at most 1,000 characters.

**Credentials.** Bearer tokens and other credential headers, credential-named
URL query values (`?api_key=`, `?token=`, `?sig=`, `X-Amz-Signature`,
`X-Goog-Credential`, `?code=`, `?jwt=`, `?pat=`, …), credentials in stdio
arguments (values of credential-named flags such as `--token X`,
`--api-key=X`, `--pat X`, `--dsn=…`; credential `-H`/`--header` values;
`NAME=VALUE` where NAME names a credential; URL passwords for any scheme,
`postgresql://`, `mongodb+srv://`, `redis://` included; credential pairs in
query and connection strings; `Bearer` values) and credential-looking
`--env` values (all of 8+ characters) are
scrubbed from the report and diff data before anything is formatted, and
again from everything any command prints or writes, in raw, markdown,
JSON-pointer, JSON, percent-encoded and base64 forms, including text the
server echoes back. A catalog that embeds the request's credential is
refused rather than written to a snapshot or raw dump. Credential headers
shorter than 8 characters are refused, and so is a `--url` with
`user:password@`. Report sources and every message label a target by URL
origin and path (credential-looking path segments masked, any query shown
only as `[query redacted]`) or, for a stdio server, by the command's
basename and a short hash of its command line, `node#1a2b3c4d`, never by
its arguments: credential syntax on a command line is open-ended, so no
masking rule can be trusted to catch it all. The hash is stable across
runs, distinguishes servers whose command lines differ in anything but a
recognized credential, and is computed over the masked command line, so it
is no guessing oracle for those. Name an ad-hoc server yourself with
`--label TEXT` (`snapshot`, `check`); configured servers are labelled by
their `name`. The sweep report's `source` keeps the basename only. URLs inside server and SDK error text are reduced the same way, and
every `?k=v` value in error text is shown as `***` whatever its name, so a
4xx body that repeats the request target (`/mcp?pwd=…`) cannot echo it.
Argument errors (`--header`, `--env` without a separator) never show the
value. `hash FILE` together with `--url` or `-- command` is an error.

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
  "capturedAt": "2026-11-10T19:09:16.838Z",
  "capturedWith": "mcp-catalog-snap/0.3.0",
  "catalog": {
    "prompts": [],
    "resourceTemplates": [ { "uriTemplate": "kronicle://docs/{slug}", "...": "..." } ],
    "tools": [ { "name": "audit_assumptions", "description": "...", "inputSchema": { "...": "..." }, "annotations": { "...": "..." } } ]
  },
  "flagSet": null,
  "format": "mcp-catalog-snap/2",
  "handshake": {
    "clientCapabilities": {},
    "clientInfo": { "name": "mcp-catalog-snap", "version": "0.3.0" },
    "negotiatedProtocolVersion": "2025-11-25",
    "requestedProtocolVersion": "2025-11-25"
  },
  "launch": {
    "args": ["-y", "kronicle-lite@0.2.0", "serve", "--token", "***"],
    "command": "npx",
    "env": { "KRONICLE_LITE_DATA_DIR": "/tmp/kl", "API_TOKEN": "***" },
    "telemetryEnv": { "DO_NOT_TRACK": "1", "OTEL_SDK_DISABLED": "true", "...": "..." },
    "transport": "stdio"
  },
  "protocolVersion": "2025-11-25",
  "server": { "name": "kronicle-lite", "version": "0.2.0" },
  "sha256": "38506578bae09476f1d2b2a6722b35a9cc5b3925013d765b1ed4cac21ecab698"
}
```

Header fields (none of them is hashed):

- `handshake`: the initialize exchange as it happened on the wire, from
  the request this client sent (`requestedProtocolVersion`,
  `clientCapabilities`, `clientInfo`) and the server's answer
  (`negotiatedProtocolVersion`). Servers can list different tools for a
  different requested version or client capabilities, so both are kept.
  `protocolVersion` repeats the negotiated version for format-1 readers.
- `launch`: how the server was reached. stdio: `command`, `args`,
  the `env` overrides the caller set (config `env`, `--env`; the inherited
  environment is not recorded) and `telemetryEnv` (see
  [Telemetry](#telemetry)). HTTP: `url` (origin + path, credential-looking
  segments masked, query never recorded) and the `headers` names (values
  never recorded). Credentials are masked before writing: values of
  credential-named flags (`--token`, `--api-key=`, `--pat`, `-t`/`-k`/`-p`),
  `-H`/`--header` values, `NAME=VALUE` where NAME names a credential, URL
  passwords for any scheme, `Bearer` / `Authorization` values,
  credential-looking strings, env values whose name looks like a credential,
  and any credential the target is known to carry. Masking is
  pattern-based: pass credentials through credential-named environment
  variables (`--env GITHUB_TOKEN=…`, config `"env": {"API_KEY":
  "${API_KEY}"}`) rather than unusual flags. Paths are recorded as given;
  use relative paths or `--cwd` if a snapshot you commit should not carry a
  home directory.
- `flagSet`: the set name for a snapshot written by `matrix`, else `null`.

**Format 1** (written by 0.1 and 0.2) has none of the three. It is still
read by every command; its `catalog` and `sha256` mean exactly what they
mean in format 2, so a format-1 baseline checks against a 0.3 capture and
`check --update` rewrites it as format 2.

- Keys are in RFC 8785 order throughout (hence the header fields sorting
  around `catalog`); the file is the canonical form pretty-printed so git
  diffs stay readable. Values nested 64 levels or deeper are written as
  compact JSON on one line (indentation would otherwise grow quadratically:
  a 6,000-level schema of 222 KB pretty-printed to 360 MB). If the file
  would still be over the 64 MiB that `check`, `diff` and `hash` read (a
  wide schema: 5.5 MB of JSON 28 levels deep with 200k leaves
  pretty-prints to ~79 MB), each tool, prompt and template keeps its own
  lines but writes its field values compact, and failing that the whole
  file is compact JSON. Bidi, invisible and C1 characters inside strings
  are written as `\u` escapes. None of this changes the values or
  `sha256`.
- `sha256` covers the compact canonical bytes of `catalog` only. A server
  version bump, a new capture time or a different header (handshake,
  launch, flag set) does not change it. Think of it as the
  **cache-prefix fingerprint**: same hash, same tool bytes.
- **The embedded `sha256` is the snapshot's identity, not the file's
  hash.** Two snapshots of the same catalog differ in `capturedAt` (and
  possibly the header), so `sha256sum file.json` differs while the
  embedded `sha256` is equal. Compare snapshots with
  `mcp-catalog-snap hash FILE` (which also verifies the file) or
  `jq -r .sha256 FILE`, and cite that value in evidence, not a file digest.
- Tools and prompts are sorted by `name`, resource templates by
  `uriTemplate`. Every field the server returned is kept (`title`,
  `description`, `inputSchema`, `outputSchema`, `annotations`, `_meta`,
  `icons`, anything else); nothing is normalized away.

### Reproducing the fingerprint

`sha256` = SHA-256 of the UTF-8 bytes of the RFC 8785 (JCS) serialization
of the `catalog` object:

1. The input is the whole `catalog` object, `{"prompts": [...],
   "resourceTemplates": [...], "tools": [...]}`, not the tools array. A
   server with no prompts or templates still hashes the two empty arrays.
2. `tools` and `prompts` are sorted by `name`, `resourceTemplates` by
   `uriTemplate` (UTF-16 code unit order). The file already stores them in
   that order.
3. Object keys at every level are sorted by UTF-16 code units; no
   whitespace; strings are escaped as ECMAScript `JSON.stringify` escapes
   them (`\"`, `\\`, `\b \f \n \r \t`, other control characters as
   lowercase `\u00xx`; everything else, non-ASCII included, as raw UTF-8);
   numbers in ECMAScript shortest form (`1e-7`, `1e+21`, `4.5`, `100`).
4. No trailing newline.

In JavaScript, plain sorted JSON is exactly this, because JCS is defined
by `JSON.stringify` and JS sorts strings by UTF-16 code units:

```sh
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const k=v=>Array.isArray(v)?v.map(k):v&&typeof v==="object"?Object.fromEntries(Object.keys(v).sort().map(x=>[x,k(v[x])])):v;process.stdout.write(require("crypto").createHash("sha256").update(JSON.stringify(k(s.catalog))).digest("hex")+"\n")' .mcp-catalog/kronicle-lite.json
```

`jq` 1.7 or later, and Python, reproduce it for typical catalogs:

```sh
jq -jcS .catalog .mcp-catalog/kronicle-lite.json | sha256sum
python3 -c 'import hashlib,json,sys; c=json.load(open(sys.argv[1],encoding="utf-8"))["catalog"]; print(hashlib.sha256(json.dumps(c,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode()).hexdigest())' .mcp-catalog/kronicle-lite.json
```

They differ from JCS, and so from `sha256`, when the catalog holds a
number written with an exponent (`1e-7`: jq 1.7 prints `1E-7`, Python
`1e-07`; jq also prints `1e+21` as `1E+21`), a DEL character (jq escapes U+007F), an
object key outside the Basic Multilingual Plane next to one in
U+E000–U+FFFF (jq and Python sort by code point), or a lone surrogate.
jq 1.6 and earlier reformat many numbers. Python's default `json.dumps`
(`ensure_ascii=True`, `", "` separators) and hashing only the tools array
do not reproduce it at all. For exact independent checks use an RFC 8785
library: [`canonicalize`](https://www.npmjs.com/package/canonicalize) (npm),
[`rfc8785`](https://pypi.org/project/rfc8785/) (PyPI) or
[`gowebpki/jcs`](https://github.com/gowebpki/jcs) (Go).

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
      - uses: rafe-walker/mcp-catalog-snap@v0.3.0
        with:
          servers-config: .mcp-catalog.json   # default
          # ignore-descriptions: 'true'
          # allow-additions: 'true'
        env:
          MCP_TOKEN: ${{ secrets.MCP_TOKEN }} # if your config uses ${MCP_TOKEN}
```

On drift the job fails, the readable diff goes to the step summary, and the
`drift` output is `"true"`. A snapshot that fails its integrity check
fails the job too (exit 3, `drift` stays `"false"`). Any other failure (a
`${VAR}` the job does not set, a server that does not start, a timeout;
exit 2) writes the error to the step summary and fails with an `::error`
as well. The `report` output is set only when the report file was written. The action builds the pinned copy of the CLI
that ships with the tag (no registry lookup at run time).

A stdio server's stderr is forwarded as the server wrote it, so the action
treats it as untrusted: it is echoed to the job log between
`::stop-commands::<random token>` and `::<token>::`, so `::error::`,
`::add-mask::` or `##[…]` lines in it are shown rather than run, and the
step summary puts it (and the drift output) in a code block whose fence is
longer than any backtick run in the text, so it cannot close the block.

### Plain shell

```yaml
      - run: npx -y mcp-catalog-snap@0.3.0 check
```

In a plain `run:` step the server's stderr goes to the log unfiltered (the
CLI's own output is neutralized, the server's is not); use the action, or
send it elsewhere with `2> server.err`, if the server is not yours.

When a change is intended, re-run `snapshot` (or `check --update`) and
commit the new `.mcp-catalog/` file in the same PR; the reviewer sees the
catalog diff next to the code that caused it.

## Programmatic use

```ts
import fs from 'node:fs/promises';
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

  Processes that leave the process group are **not reaped**: anything the
  server starts with `setsid` / `setpgid`, Node `spawn(..., { detached:
  true })` children (Puppeteer and Playwright launch their browsers this
  way, so a browser-automation server can leave Chrome running), and
  Docker containers. For Docker, `docker run` is only a client: ending it
  does not stop the container, which keeps running under the daemon. Run
  such servers as `docker run -i --rm --init …` (`--rm` removes the
  container when it exits, `--init` forwards signals to the server inside
  it and reaps its children), and in CI clean up leftovers yourself
  (`docker ps`, `pkill -f chrome`) or give the job a timeout.

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

See `CONTRIBUTING.md` (DCO sign-off, Apache-2.0). Install dependencies with
`npm ci`: `npm install` can leave a `node_modules` that does not match the
lockfile (a stale tree once broke the type build and the CLI).

---

Built and maintained by [IsoKron](https://isokron.ai).

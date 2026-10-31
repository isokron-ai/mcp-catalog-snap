# Contributing to mcp-catalog-snap

Thanks for taking a look. mcp-catalog-snap is small on purpose; contributions
that keep it small are the most welcome.

## Ground rules

- **Apache-2.0.** By contributing you agree your contribution is licensed
  under the Apache License 2.0 (see `LICENSE`).
- **Developer Certificate of Origin (DCO).** Every commit must be signed off
  (`git commit -s`), which adds a `Signed-off-by:` trailer certifying the
  [DCO 1.1](https://developercertificate.org/): you wrote the change or have
  the right to submit it under the project's license. Unsigned commits will
  be asked to be re-pushed with sign-off.
- **No secrets, ever.** No tokens, `.env` files or snapshots captured from
  private servers with real credentials in their headers.
- **Format changes are breaking.** Anything that changes the snapshot
  layout, the canonicalization, what is included in the hashed `catalog`
  body, or the sort keys must bump `SNAPSHOT_FORMAT` and keep parsing the
  previous format. A fingerprint computed by 0.1.0 must still be
  reproducible by later releases.

## Dev loop

```sh
npm install
npm run build      # tsup → dist/
npm test           # vitest (builds first; spawns kronicle-lite / sea-lite from node_modules)
npm run lint       # eslint flat config
npm run typecheck  # tsc --noEmit
```

Regenerate the dogfood snapshots after bumping the pinned example servers:

```sh
npm run build && npm run snapshot:examples
```

## Pull requests

- One logical change per PR. Tests for anything that touches
  canonicalization, the diff, the exit codes or the action script.
- Keep dependencies minimal: the runtime set is the MCP SDK and
  `canonicalize`. New runtime dependencies need a reason.

## Reporting security issues

Please do not open a public issue for a suspected way to make `check` pass
on a drifted catalog. Email the maintainer (see `package.json`) with details
and a reproduction.

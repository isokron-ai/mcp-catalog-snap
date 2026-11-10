/**
 * How a server was reached, recorded in the snapshot header, and the
 * telemetry-off environment for servers catalog-snap launches itself.
 *
 * A catalog depends on how the server was started: command-line flags,
 * toolsets, read-only switches and environment variables change which tools
 * it lists. A snapshot that does not say how it was taken cannot be
 * reproduced, so every capture records its launch: for stdio the command,
 * its arguments and the environment overrides the caller set (credentials
 * masked); for HTTP the URL (origin + path) and the header names. None of it
 * is hashed: the fingerprint stays the catalog's alone.
 */

import type { Target } from './capture.js';
import { REDACTED, credentialEnvName, maskArg, maskedArgs, safeUrl, scrubDeep, secretVariants, targetSecrets } from './redact.js';

/**
 * Environment variables set for every stdio server catalog-snap launches,
 * unless turned off (`--no-telemetry-defaults`, config
 * `"telemetryDefaults": false`). Widely honoured opt-outs only; add
 * server-specific ones with `--telemetry-env KEY=VALUE` or config
 * `"telemetryEnv"`.
 */
export const TELEMETRY_OFF_ENV: Readonly<Record<string, string>> = Object.freeze({
  // consoledonottrack.com: the generic opt-out many CLIs and SDKs read
  DO_NOT_TRACK: '1',
  // OpenTelemetry SDKs (traces / metrics exporters)
  OTEL_SDK_DISABLED: 'true',
  // HashiCorp checkpoint (Go tools from HashiCorp)
  CHECKPOINT_DISABLE: '1',
  // Hugging Face hub client
  HF_HUB_DISABLE_TELEMETRY: '1',
  // .NET SDK / CLI
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  // Next.js
  NEXT_TELEMETRY_DISABLED: '1',
  // Scarf (npm / PyPI package analytics)
  SCARF_ANALYTICS: 'false',
  // Chroma and other PostHog-based Python clients
  ANONYMIZED_TELEMETRY: 'false',
});

export interface TelemetryOptions {
  /** Apply TELEMETRY_OFF_ENV (default true). */
  defaults?: boolean;
  /** Further variables to set, applied after the defaults. */
  extra?: Record<string, string>;
}

/** The telemetry-off variables to set: the defaults (unless disabled), then the caller's extras. */
export function telemetryEnv(opts: TelemetryOptions = {}): Record<string, string> {
  const out: Record<string, string> = {};
  if (opts.defaults !== false) Object.assign(out, TELEMETRY_OFF_ENV);
  Object.assign(out, opts.extra ?? {});
  return out;
}

/**
 * The child's environment: the inherited environment, then the
 * telemetry-off variables (they override an inherited value), then the
 * target's own `env` (the caller's explicit choice wins). Also returns the
 * telemetry variables as the child actually received them.
 */
export function childEnv(
  target: { env?: Record<string, string> },
  telemetry: TelemetryOptions = {},
  inherited: NodeJS.ProcessEnv = process.env,
): { env: Record<string, string>; telemetry: Record<string, string> } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(inherited)) if (v !== undefined) env[k] = v;
  const tele = telemetryEnv(telemetry);
  Object.assign(env, tele, target.env ?? {});
  const applied: Record<string, string> = {};
  for (const k of Object.keys(tele).sort()) applied[k] = env[k]!;
  return { env, telemetry: applied };
}

export interface StdioLaunch {
  transport: 'stdio';
  /** The command as given (a credential-looking command is masked). */
  command: string;
  /** Arguments as given, credentials masked (`--token ***`, `-H "Authorization: ***"`, `postgres://***@…`). */
  args: string[];
  /** Environment overrides the caller set (config `env`, `--env`), credential-named or credential-looking values masked. The inherited environment is not recorded. */
  env: Record<string, string>;
  /** Telemetry-off variables the child received, with the values it received. */
  telemetryEnv: Record<string, string>;
}

export interface HttpLaunch {
  transport: 'http';
  /** Origin + path (credential-looking segments masked, query never recorded). */
  url: string;
  /** Names of the headers sent (values are never recorded). */
  headers: string[];
}

export type LaunchRecord = StdioLaunch | HttpLaunch;

/** A launch record for `target`, safe to write to a snapshot: no credential the target carries survives in it. */
export function describeLaunch(target: Target, telemetryApplied: Record<string, string> = {}): LaunchRecord {
  let rec: LaunchRecord;
  if (target.kind === 'http') {
    rec = { transport: 'http', url: safeUrl(target.url), headers: Object.keys(target.headers ?? {}).sort() };
  } else {
    const env: Record<string, string> = {};
    for (const k of Object.keys(target.env ?? {}).sort()) {
      const v = target.env![k]!;
      env[k] = credentialEnvName(k) ? REDACTED : maskArg(v);
    }
    rec = { transport: 'stdio', command: maskArg(target.command), args: maskedArgs(target.args), env, telemetryEnv: { ...telemetryApplied } };
  }
  // defence in depth: whatever the masking rules missed, the target's known credentials do not reach the file
  return scrubDeep(rec, secretVariants(targetSecrets(target)));
}

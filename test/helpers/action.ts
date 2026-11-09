import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** The bash body of action.yml's `check` step (the `run: |` block). */
export function actionCheckScript(): string {
  const action = readFileSync(join(ROOT, 'action.yml'), 'utf8');
  const step = action.slice(action.indexOf('id: check'));
  const body = step.slice(step.indexOf('run: |') + 'run: |'.length).split('\n');
  const lines: string[] = [];
  for (const l of body.slice(1)) {
    if (l.trim() !== '' && !l.startsWith('        ')) break;
    lines.push(l.slice(8));
  }
  return lines.join('\n');
}

/** Run the check step in `dir` the way the runner would; returns the log, summary and outputs. */
export function runActionCheck(dir: string, inputs: Record<string, string> = {}, env: NodeJS.ProcessEnv = {}) {
  const summary = join(dir, 'summary.md');
  const outputs = join(dir, 'outputs.txt');
  const r = spawnSync('bash', ['-c', actionCheckScript()], {
    encoding: 'utf8',
    cwd: dir,
    timeout: 120_000,
    env: {
      PATH: process.env['PATH'] ?? '',
      HOME: dir,
      GITHUB_ACTION_PATH: ROOT,
      GITHUB_OUTPUT: outputs,
      GITHUB_STEP_SUMMARY: summary,
      RUNNER_TEMP: dir,
      INPUT_CONFIG: '.mcp-catalog.json',
      INPUT_IGNORE_DESCRIPTIONS: 'false',
      INPUT_ALLOW_ADDITIONS: 'false',
      INPUT_SERVER: '',
      INPUT_TIMEOUT: '30000',
      INPUT_TIMEOUT_TOTAL: '',
      ...inputs,
      ...env,
    },
  });
  const read = (p: string): string => (existsSync(p) ? readFileSync(p, 'utf8') : '');
  return { code: r.status, log: `${r.stdout}\n${r.stderr}`, summary: read(summary), outputs: read(outputs) };
}

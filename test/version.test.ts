import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { VERSION } from '../src/version.js';

describe('VERSION', () => {
  it('matches package.json exactly', () => {
    const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it('is a plain semver string', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
  });

  it('is ahead of the last released version while CHANGELOG has unreleased changes (report generator is not stale)', () => {
    const log = readFileSync(fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)), 'utf8');
    const unreleased = /^## \[Unreleased\]\s*\n([\s\S]*?)^## \[/m.exec(log)?.[1] ?? '';
    const released = /^## \[(\d+)\.(\d+)\.(\d+)\]/m.exec(log);
    expect(released).not.toBeNull();
    if (!/^- /m.test(unreleased)) return;
    const [maj, min, pat] = VERSION.split(/[-+]/)[0]!.split('.').map(Number) as [number, number, number];
    const [rMaj, rMin, rPat] = released!.slice(1).map(Number) as [number, number, number];
    const cmp = maj - rMaj || min - rMin || pat - rPat;
    expect(cmp, `package.json ${VERSION} must be past the released ${released![0]} while [Unreleased] has entries`).toBeGreaterThan(0);
  });

  it('is what the built CLI reports (dist is not stale)', () => {
    const dist = readFileSync(fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'utf8');
    // The build must read package.json at runtime, not inline a build-time copy.
    expect(dist).toMatch(/require\d*\("\.\.\/package\.json"\)/);
    expect(dist).not.toMatch(/VERSION = "\d+\.\d+\.\d+"/);
  });
});

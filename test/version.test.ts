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

  it('is what the built CLI reports (dist is not stale)', () => {
    const dist = readFileSync(fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'utf8');
    // The build must read package.json at runtime, not inline a build-time copy.
    expect(dist).toMatch(/require\d*\("\.\.\/package\.json"\)/);
    expect(dist).not.toMatch(/VERSION = "\d+\.\d+\.\d+"/);
  });
});

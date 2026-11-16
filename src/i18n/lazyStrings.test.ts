import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_LANGS } from './index';

// v1.21.1 — every on-demand string file (i18n/lazy/*.json) carries all ten
// languages, each with exactly the English keys. A missing translation would
// otherwise fall back to English with no sign.
const DIR = join(__dirname, 'lazy');

const leaves = (node: unknown, prefix = ''): string[] =>
  node && typeof node === 'object'
    ? Object.entries(node as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${prefix}${k}.`))
    : [prefix.slice(0, -1)];

describe('on-demand strings', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));

  it.each(files)('%s has every language with the English keys', (file) => {
    const all = JSON.parse(readFileSync(join(DIR, file), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(all).sort()).toEqual([...SUPPORTED_LANGS].sort());
    const en = leaves(all.en).sort();
    expect(en.length).toBeGreaterThan(0);
    for (const lng of SUPPORTED_LANGS) expect([lng, leaves(all[lng]).sort()]).toEqual([lng, en]);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import en from './locales/en.json';

// v1.17 (NCC#111) — every literal key passed to `t()` must exist in en.json.
// A missing key has no fallback: i18next prints the key itself, in every
// language. `yearReview.back` shipped that way for months because nothing
// checked. Keys built at runtime (`t(\`fin.${x}\`)`) are out of reach of a
// static scan and are not covered here.

const SRC = join(__dirname, '..');
const KEY = /\bt\(\s*(['"])([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\1/g;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

function lookup(key: string): unknown {
  return key.split('.').reduce<unknown>(
    (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
    en,
  );
}

// A plural key is called by its base name and stored as `_one`/`_other`.
const exists = (key: string) =>
  lookup(key) !== undefined || lookup(`${key}_one`) !== undefined || lookup(`${key}_other`) !== undefined;

describe('i18n keys', () => {
  it('every literal t() key resolves in en.json', () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of sourceFiles(SRC)) {
      for (const match of readFileSync(file, 'utf8').matchAll(KEY)) {
        seen++;
        if (!exists(match[2])) missing.push(`${match[2]} (${file.slice(SRC.length + 1)})`);
      }
    }
    // Guards the scan itself: a regex that silently matched nothing would pass.
    expect(seen).toBeGreaterThan(1000);
    expect(missing).toEqual([]);
  });
});

// v1.18.1 (NCC#155): a plural form a locale lacks falls back to English, so
// Arabic read "3 positions" in the middle of an Arabic screen. Every plural
// key in en.json must carry, in each locale, every CLDR category that counts
// 0–1000 can select there (Arabic: zero, one, two, few, many, other).
describe('i18n plurals', () => {
  const SUFFIX = /_(zero|one|two|few|many|other)$/;
  const LOCALES = join(SRC, 'i18n/locales');

  const pluralForms = (tree: Record<string, unknown>) => {
    const out = new Map<string, Set<string>>();
    const walk = (node: Record<string, unknown>, prefix: string) => {
      for (const [k, v] of Object.entries(node)) {
        if (v && typeof v === 'object') walk(v as Record<string, unknown>, `${prefix}${k}.`);
        else {
          const m = k.match(SUFFIX);
          if (!m) continue;
          const base = prefix + k.slice(0, -m[0].length);
          if (!out.has(base)) out.set(base, new Set());
          out.get(base)!.add(m[1]);
        }
      }
    };
    walk(tree, '');
    return out;
  };

  it('every locale has every plural form its counts can select', () => {
    const enBases = [...pluralForms(en as Record<string, unknown>).keys()];
    expect(enBases.length).toBeGreaterThan(5);
    const gaps: string[] = [];
    for (const file of readdirSync(LOCALES).filter((f) => f.endsWith('.json'))) {
      const lng = file.slice(0, -5);
      const forms = pluralForms(JSON.parse(readFileSync(join(LOCALES, file), 'utf8')));
      const rules = new Intl.PluralRules(lng);
      const needed = new Set<string>();
      for (let n = 0; n <= 1000; n++) needed.add(rules.select(n));
      for (const base of enBases) {
        const have = forms.get(base) ?? new Set<string>();
        const missing = [...needed].filter((c) => !have.has(c));
        if (missing.length) gaps.push(`${lng} ${base}: ${missing.join('/')}`);
      }
    }
    expect(gaps).toEqual([]);
  });
});

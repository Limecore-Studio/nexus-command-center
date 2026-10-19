import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// v1.18 (limecore#21) — no store selector may build a fresh array or object.
// zustand 5 compares a selector's result with Object.is. A selector that
// returns a new array on every call (`s => s.items.filter(...)`) never
// compares equal, so React re-renders forever (error #185). Under zustand 4
// the same code was merely wasteful, so nothing flagged it: tsc and every
// test passed, and the first zustand 5 build crashed on launch, because one
// such selector sits in a sheet AppShell always mounts. Wrap derived
// selections in useShallow, or select the raw field and derive in useMemo.
//
// A static scan, so it sees the common shapes, not every possible one:
// array/object literals and the array methods that always allocate.

const SRC = join(__dirname, '..');
const CALL = /\b(use[A-Z]\w*Store)\(/g;
// After `s =>`: an object or array literal, or an allocating call anywhere.
const FRESH = /^\(?\s*[{[]|\.(filter|map|slice|concat|sort|toSorted|toReversed|flatMap)\(|\bObject\.(keys|values|entries|fromEntries)\(|\.\.\./;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(path);
  }
  return out;
}

/** The text between a call's opening paren and its matching close. */
function argument(src: string, open: number): string {
  let depth = 1;
  let i = open;
  while (i < src.length && depth) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') depth--;
    i++;
  }
  return src.slice(open, i - 1);
}

describe('store selectors (zustand 5)', () => {
  it('never return a fresh array or object without useShallow', () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of sourceFiles(SRC)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(CALL)) {
        if (m[1] === 'useSyncExternalStore') continue; // React's, not a store
        const arg = argument(src, m.index! + m[0].length).trim();
        if (!arg || arg.startsWith('useShallow(')) continue;
        seen++;
        const body = arg.replace(/^\(?\s*\w+\s*\)?\s*=>\s*/, '');
        if (FRESH.test(body)) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${file.slice(SRC.length + 1)}:${line}  ${arg.replace(/\s+/g, ' ').slice(0, 90)}`);
        }
      }
    }
    expect(seen).toBeGreaterThan(100); // the scan is actually finding the selectors
    expect(offenders).toEqual([]);
  });
});

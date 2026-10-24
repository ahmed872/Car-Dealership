// Every error code the API can return must have a translation in the global `errors` block,
// because errorMessage() (components/ui/Feedback.tsx) looks up `errors.<code>` and otherwise
// shows the server's English message. The codes are read from the API source itself.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PIPELINE_STAGE_KINDS } from '@autohub/shared';
import { describe, expect, it } from 'vitest';
import ar from './ar';
import en from './en';

const API_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../../api/src');

/** Codes built with a template literal in the API, keyed by the literal's source text. */
const DYNAMIC_CODES: Record<string, readonly string[]> = {
  'last_${s.kind}_stage': PIPELINE_STAGE_KINDS.map((k) => `last_${k}_stage`),
};

/** A quoted string literal ('…', "…" or `…`); `n` is the number of its quote's capture group. */
const str = (n: number) => `(['"\\x60])((?:\\\\.|(?!\\${n})[^\\\\])*)\\${n}`;
const CODE_RE = /^[a-z][a-z0-9_]*$/;

interface Found {
  codes: Map<string, string>; // code -> first place it was seen
  problems: string[]; // code expressions the extractor cannot resolve
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sourceFiles(p);
    return /\.ts$/.test(name) && !/\.(spec|test|d)\.ts$/.test(name) ? [p] : [];
  });
}

/** Blanks out comments that start a line (keeps line numbers), so examples in docs are not read as codes. */
function stripComments(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, blank).replace(/^[ \t]*\/\/.*$/gm, blank);
}

/**
 * Reads common/errors.ts: helpers that build an AppError either with a fixed code (`forbidden()`,
 * `notFound()`) or with a code taken from one of their parameters (`conflict(code, …)`).
 */
function errorHelpers(src: string) {
  const fixed = new Map<string, string>();
  const byParam: string[] = [];
  const re = /export const (\w+)\s*=\s*\(([\s\S]*?)\)\s*=>\s*new AppError\(\s*([^,]+?)\s*,/g;
  for (const m of src.matchAll(re)) {
    const [, name, params, first] = m as unknown as [string, string, string, string];
    const literal = /^(['"])([a-z0-9_]+)\1$/.exec(first);
    if (literal) {
      fixed.set(name, literal[2]!);
      continue;
    }
    const firstParam = params.trim().split(/[\s:?=,]/)[0];
    if (firstParam !== first) {
      throw new Error(`errors.test.ts: ${name}() takes its code from a parameter other than the first; extend the extractor`);
    }
    byParam.push(name);
  }
  return { fixed, byParam };
}

function extractApiErrorCodes(): Found {
  const found: Found = { codes: new Map(), problems: [] };
  const errorsSrc = readFileSync(join(API_SRC, 'common/errors.ts'), 'utf8');
  const { fixed, byParam } = errorHelpers(errorsSrc);
  expect(byParam.length, 'conflict/unprocessable/badRequest helpers found in common/errors.ts').toBeGreaterThan(0);

  for (const file of sourceFiles(API_SRC)) {
    const rel = relative(API_SRC, file);
    const src = stripComments(readFileSync(file, 'utf8'));
    const at = (index: number) => `${rel}:${src.slice(0, index).split('\n').length}`;
    const add = (code: string, index: number) => {
      if (code.includes('${')) {
        const expanded = DYNAMIC_CODES[code];
        if (!expanded) found.problems.push(`${at(index)} builds the code \`${code}\`; add it to DYNAMIC_CODES`);
        for (const c of expanded ?? []) if (!found.codes.has(c)) found.codes.set(c, at(index));
        return;
      }
      if (!CODE_RE.test(code)) found.problems.push(`${at(index)} uses "${code}", which is not a snake_case code`);
      if (!found.codes.has(code)) found.codes.set(code, at(index));
    };
    const call = (name: string) => String.raw`(?<![\w$.])${name}\(\s*`;

    // Helpers with a fixed code: any call returns it.
    for (const [name, code] of fixed) {
      for (const m of src.matchAll(new RegExp(call(name), 'g'))) add(code, m.index);
    }
    // conflict('code', …), unprocessable('code', …), badRequest('code', …) — including multi-line calls.
    for (const name of byParam) {
      for (const m of src.matchAll(new RegExp(call(name) + `(?:${str(1)})?`, 'g'))) {
        if (m[2] === undefined) found.problems.push(`${at(m.index)} calls ${name}() with a non-literal code`);
        else add(m[2], m.index);
      }
    }
    // new AppError('code', status, message)
    if (rel !== 'common/errors.ts') {
      for (const m of src.matchAll(new RegExp(String.raw`new AppError\(\s*(?:${str(1)})?`, 'g'))) {
        if (m[2] === undefined) found.problems.push(`${at(m.index)} creates an AppError with a non-literal code`);
        else add(m[2], m.index);
      }
    }
    // registerUniqueConstraint('constraint_name', 'code', message)
    for (const m of src.matchAll(new RegExp(String.raw`(?<!function )registerUniqueConstraint\(\s*(?:${str(1)}\s*,\s*${str(3)})?`, 'g'))) {
      if (m[4] === undefined) found.problems.push(`${at(m.index)} registers a unique constraint with a non-literal code`);
      else add(m[4], m.index);
    }
    // Error bodies built directly: UNIQUE_CONSTRAINT_MESSAGES in errors.ts and the global error filter,
    // e.g. `code: 'rate_limited'`, `code: mapped?.code ?? 'duplicate'` and `413: 'payload_too_large'`.
    if (rel === 'common/errors.ts' || rel === 'common/error.filter.ts') {
      for (const m of src.matchAll(new RegExp(String.raw`\bcode:\s*(?:[^,'"\x60\n}]*\?\?\s*)?${str(1)}`, 'g'))) add(m[2]!, m.index);
      for (const m of src.matchAll(/^\s*\d{3}:\s*(['"])([a-z][a-z0-9_]*)\1/gm)) add(m[2]!, m.index);
    }
  }
  return found;
}

const arErrors: Record<string, string> = ar.errors;
const enErrors: Record<string, string> = en.errors;
const api = extractApiErrorCodes();
const apiCodes = [...api.codes.keys()].sort();

function missingIn(dict: Record<string, string>): string[] {
  return apiCodes
    .filter((code) => typeof dict[code] !== 'string' || !dict[code].trim())
    .map((code) => `${code} (${api.codes.get(code)})`);
}

describe('API error code translations', () => {
  it('finds the API error codes', () => {
    expect(api.problems, 'code expressions the extractor could not resolve').toEqual([]);
    // Guards against a broken path or regex silently finding nothing.
    expect(apiCodes.length).toBeGreaterThan(200);
    for (const code of ['not_found', 'forbidden', 'unauthorized', 'validation_failed', 'duplicate', 'insufficient_cash', 'last_open_stage']) {
      expect(apiCodes).toContain(code);
    }
  });

  it('translates every API error code in Arabic', () => {
    expect(missingIn(arErrors), 'add these codes to errors in src/i18n/ar.ts').toEqual([]);
  });

  it('translates every API error code in English', () => {
    expect(missingIn(enErrors), 'add these codes to errors in src/i18n/en.ts').toEqual([]);
  });

  it('has the same error keys in Arabic and English', () => {
    expect(Object.keys(enErrors).sort()).toEqual(Object.keys(arErrors).sort());
  });

  it('keeps API error messages static (errorMessage passes no interpolation values)', () => {
    const interpolated = apiCodes.filter((code) => /\{\{/.test(arErrors[code] ?? '') || /\{\{/.test(enErrors[code] ?? ''));
    expect(interpolated).toEqual([]);
  });
});

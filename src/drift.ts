import { basename, dirname, join } from 'node:path';

export const RULES = ['missing', 'extra', 'type', 'placeholder', 'tag', 'untranslated', 'empty', 'invalid-json'] as const;
export type Rule = (typeof RULES)[number];
export type Severity = 'error' | 'warning';
export type Finding = { file: string; locale: string; key?: string; rule: Rule; severity: Severity; message: string };
export type LocaleFile = { file: string; locale: string; ns?: string; text: string };
export type Format = 'icu' | 'i18next';

// The free scope: fixed limits, enforced loudly instead of truncating.
export const MAX_KEYS = 5000;
export const MAX_TARGETS = 10;
export const MAX_BYTES = 5_000_000;

const SEVERITY: Record<Rule, Severity> = {
  missing: 'error', extra: 'warning', type: 'error', placeholder: 'error', tag: 'error', untranslated: 'warning', empty: 'warning', 'invalid-json': 'error',
};

const LANGUAGES = new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' });
const LOCALE_SHAPE = /^[a-z]{2,3}(?:[-_](?:[A-Za-z]{4}|[A-Za-z]{2}|\d{3}))*$/;

// A real BCP 47 locale such as en, ms-MY or zh-Hant-TW; "app" or "common" are not.
export function isLocale(name: string): boolean {
  if (!LOCALE_SHAPE.test(name)) return false;
  try {
    return LANGUAGES.of(name.replace(/_/g, '-')) !== undefined;
  } catch {
    return false;
  }
}

// messages/ms.json -> { locale: 'ms' }; public/locales/ms/common.json -> { locale: 'ms', ns: 'common' }.
export function classify(path: string): { locale: string; ns?: string } | undefined {
  if (!path.endsWith('.json')) return undefined;
  const name = basename(path, '.json');
  const parent = basename(dirname(path));
  // The file name wins, so src/ms.json is ms even though "src" is also a language code.
  if (isLocale(name)) return { locale: name };
  return isLocale(parent) ? { locale: parent, ns: name } : undefined;
}

type Flat = { leaves: Map<string, unknown>; containers: Set<string> };

function flatten(value: unknown, prefix: string, out: Flat): Flat {
  if (value !== null && typeof value === 'object') {
    if (prefix) out.containers.add(prefix);
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
    for (const [k, v] of entries) flatten(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.leaves.set(prefix, value);
  }
  return out;
}

// Walks ICU MessageFormat: argument names from every plural/select branch, plus the literal text
// (branch bodies included, selectors and # left out) for the untranslated check.
function icuParse(s: string): { names: Set<string>; ok: boolean; text: string } {
  const names = new Set<string>();
  let i = 0;
  let ok = true;
  let text = '';
  // An apostrophe quotes a following { } (or # in a plural) up to the next lone '; '' is a literal '.
  const quoted = (inPlural: boolean): string | undefined => {
    if (s[i] !== "'") return undefined;
    if (s[i + 1] === "'") {
      i += 2;
      return "'";
    }
    if (!(s[i + 1] === '{' || s[i + 1] === '}' || (inPlural && s[i + 1] === '#'))) {
      i++;
      return "'";
    }
    let lit = '';
    for (i++; i < s.length; i++) {
      if (s[i] !== "'") lit += s[i];
      else if (s[i + 1] === "'") lit += s[++i];
      else break;
    }
    i++;
    return lit;
  };
  const message = (inPlural: boolean, nested: boolean): void => {
    while (i < s.length) {
      const lit = quoted(inPlural);
      if (lit !== undefined) {
        text += lit;
        continue;
      }
      const c = s[i++];
      if (c === '{') argument();
      else if (c === '}') {
        if (nested) return;
        ok = false;
      } else if (!(inPlural && c === '#')) text += c;
    }
    if (nested) ok = false;
  };
  const readUntil = (stops: string): string => {
    const start = i;
    while (i < s.length && !stops.includes(s[i])) i++;
    return s.slice(start, i).trim();
  };
  const argument = (): void => {
    text += ' ';
    const name = readUntil(',}{');
    if (i >= s.length || s[i] === '{' || !name) {
      ok = false;
      return;
    }
    names.add(name);
    if (s[i++] === '}') return;
    const type = readUntil(',}');
    if (i >= s.length) {
      ok = false;
      return;
    }
    if (s[i++] === '}') return;
    if (type === 'plural' || type === 'select' || type === 'selectordinal') {
      for (;;) {
        readUntil('{}'); // selector, or offset:1
        if (i >= s.length) break;
        if (s[i++] === '}') return;
        message(type !== 'select', true);
        text += ' ';
      }
      ok = false;
      return;
    }
    // A style such as ::currency/MYR: skip to the closing brace.
    let depth = 1;
    while (i < s.length && depth) {
      if (quoted(false) !== undefined) continue;
      if (s[i] === '{') depth++;
      else if (s[i] === '}') depth--;
      i++;
    }
    if (depth) ok = false;
  };
  message(false, false);
  return { names, ok, text };
}

const count = (s: string, sub: string) => s.split(sub).length - 1;

export function argNames(s: string, format: Format): { names: Set<string>; ok: boolean } {
  if (format === 'icu') {
    const { names, ok } = icuParse(s);
    return { names, ok };
  }
  const names = new Set<string>();
  for (const m of s.matchAll(/\{\{\s*-?\s*([^,}\s]+)[^}]*\}\}/g)) names.add(m[1]);
  for (const m of s.matchAll(/\$t\(\s*([^,)\s]+)[^)]*\)/g)) names.add(`$t(${m[1]})`);
  return { names, ok: count(s, '{{') === count(s, '}}') };
}

const TAG = /<(\/?)(?:([A-Za-z][\w-]*)(?:\s[^<>]*?)?|(\d+))\s*(\/?)>/g;

// The distinct tags: <b>, </b>, <br/>, and react-i18next's <0>, <1/>. Attributes are ignored.
// A set, not a count, because a plural with fewer branches (ms has only "other") repeats them fewer times.
export function tags(s: string): string[] {
  return [...new Set([...s.matchAll(TAG)].map((m) => `<${m[1]}${m[2] ?? m[3]}${m[4]}>`))].sort();
}

// Letter words left once placeholders, tags, links and numbers are gone. One word alone is often a valid loanword.
// For ICU it counts the text of every plural/select branch, so a copied plural message is caught.
function words(s: string, format: Format): number {
  let rest = format === 'icu' ? icuParse(s).text : s.replace(/\$t\([^)]*\)/g, ' ').replace(/\{\{[^}]*\}\}/g, ' ');
  rest = rest.replace(TAG, ' ').replace(/\bhttps?:\/\/\S+|\bwww\.\S+|\S+@\S+\.\S+/g, ' ');
  // Distinct words, so the same loanword in every plural branch (one {# km} other {# km}) is still one.
  return new Set((rest.match(/\p{L}[\p{L}\p{M}'’]+/gu) ?? []).map((w) => w.toLocaleLowerCase())).size;
}

// en and en-GB are one language; zh-Hans and zh-Hant are not, because the script differs.
function language(locale: string): string {
  try {
    const l = new Intl.Locale(locale.replace(/_/g, '-')).maximize();
    return `${l.language}-${l.script ?? ''}`;
  } catch {
    return locale.split(/[-_]/)[0].toLowerCase();
  }
}

function pluralCategories(locale: string, type: Intl.PluralRuleType): Set<string> | undefined {
  try {
    return new Set(new Intl.PluralRules(locale.replace(/_/g, '-'), { type }).resolvedOptions().pluralCategories);
  } catch {
    return undefined;
  }
}

const PLURAL_KEY = /^(.*?)(_ordinal)?_(zero|one|two|few|many|other)$/;

// An i18next plural set has _other plus at least one other form; gender_other or option_other alone is a plain key.
const isPluralSet = (base: string, keys: Map<string, unknown>) =>
  keys.has(`${base}_other`) && ['zero', 'one', 'two', 'few', 'many'].some((c) => keys.has(`${base}_${c}`));

// For a key in an i18next plural set, whether the target language uses that form.
// _zero counts only where CLDR has a zero form (ar, lv); elsewhere it is i18next's optional extra.
function pluralForm(key: string, keys: Map<string, unknown>, locale: string, format: Format): 'used' | 'unused' | undefined {
  const m = PLURAL_KEY.exec(key);
  if (format !== 'i18next' || !m || !isPluralSet(`${m[1]}${m[2] ?? ''}`, keys)) return undefined;
  const cats = pluralCategories(locale, m[2] ? 'ordinal' : 'cardinal');
  return !cats || cats.has(m[3]) ? 'used' : 'unused';
}

type Parsed = { file: LocaleFile; flat: Flat };

function parse(file: LocaleFile, findings: Finding[]): Parsed | undefined {
  if (Buffer.byteLength(file.text, 'utf8') > MAX_BYTES) throw new Error(`${file.file} is larger than ${MAX_BYTES / 1_000_000} MB`);
  let value: unknown;
  try {
    value = JSON.parse(file.text.replace(/^﻿/, ''));
  } catch (e) {
    findings.push({ file: file.file, locale: file.locale, rule: 'invalid-json', severity: 'error', message: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` });
    return undefined;
  }
  const flat = flatten(value, '', { leaves: new Map(), containers: new Set() });
  if (flat.leaves.size > MAX_KEYS) throw new Error(`${file.file} has ${flat.leaves.size} keys; locale-drift checks up to ${MAX_KEYS} per file`);
  return { file, flat };
}

// A whole {{name}} or {{name, format}}, or $t(…). ICU's "one {{name} liked}" is not one.
const I18NEXT = /\{\{\s*-?\s*[\w.$:-]+\s*(?:,[^{}]*)?\}\}|\$t\(/;
// A valid ICU plural/select can contain {{n}} as a branch body (other {{n}}); that is not i18next.
const ICU_BRANCHES = /\{\s*[\w.$-]+\s*,\s*(?:plural|select|selectordinal)\s*,/;
const looksI18next = (v: string) => I18NEXT.test(v) && !(ICU_BRANCHES.test(v) && icuParse(v).ok);

function detectFormat(sources: Parsed[]): Format {
  for (const p of sources) for (const v of p.flat.leaves.values()) if (typeof v === 'string' && looksI18next(v)) return 'i18next';
  return 'icu';
}

const show = (name: string, format: Format) => (format === 'icu' ? `{${name}}` : name.startsWith('$t(') ? name : `{{${name}}}`);
const diff = (a: Iterable<string>, b: Iterable<string>) => {
  const rest = [...b];
  return [...a].filter((x) => {
    const at = rest.indexOf(x);
    if (at === -1) return true;
    rest.splice(at, 1);
    return false;
  });
};

function compareValues(s: string, t: string, format: Format, sameLanguage: boolean): [Rule, string][] {
  if (t === '' && s !== '') return [['empty', 'is empty']];
  const out: [Rule, string][] = [];
  const as = argNames(s, format);
  const at = argNames(t, format);
  if (as.ok && !at.ok) out.push(['placeholder', 'has unbalanced braces']);
  else {
    const lost = diff(as.names, at.names).map((n) => show(n, format));
    const added = diff(at.names, as.names).map((n) => show(n, format));
    if (lost.length || added.length) {
      out.push(['placeholder', [lost.length && `missing ${lost.join(', ')}`, added.length && `unexpected ${added.join(', ')}`].filter(Boolean).join('; ')]);
    }
  }
  const lostTags = diff(tags(s), tags(t));
  const addedTags = diff(tags(t), tags(s));
  if (lostTags.length || addedTags.length) {
    out.push(['tag', [lostTags.length && `missing ${lostTags.join(' ')}`, addedTags.length && `unexpected ${addedTags.join(' ')}`].filter(Boolean).join('; ')]);
  }
  if (!sameLanguage && s === t && words(s, format) >= 2) out.push(['untranslated', 'is the same as the source; translate it or --ignore untranslated']);
  return out;
}

// The first prefix of key (a.b of a.b.c) that is a leaf on the other side, for type mismatches.
function leafPrefix(key: string, leaves: Map<string, unknown>): string | undefined {
  const parts = key.split('.');
  for (let n = 1; n < parts.length; n++) {
    const p = parts.slice(0, n).join('.');
    if (leaves.has(p)) return p;
  }
  return undefined;
}

function comparePair(src: Parsed, tgt: Parsed, format: Format): Finding[] {
  const { locale, file, ns } = tgt.file;
  const sameLanguage = language(locale) === language(src.file.locale);
  const S = src.flat;
  const T = tgt.flat;
  const out: Finding[] = [];
  const typed = new Set<string>();
  const key = (k: string) => (ns ? `${ns}:${k}` : k);
  const add = (k: string, rule: Rule, message: string, severity = SEVERITY[rule]) => out.push({ file, locale, key: key(k), rule, severity, message });
  const type = (k: string) => {
    if (typed.has(k)) return;
    typed.add(k);
    add(k, 'type', 'is a string on one side and an object or other type on the other');
  };
  for (const [k, s] of S.leaves) {
    if (T.leaves.has(k)) {
      const t = T.leaves.get(k);
      if (typeof s !== typeof t || s === null || t === null) {
        if (s !== t) type(k);
      } else if (typeof s === 'string') {
        for (const [rule, message] of compareValues(s, t as string, format, sameLanguage)) add(k, rule, message);
      }
      continue;
    }
    // A prefix that is a leaf on both sides is a flat dotted key (react-intl "home.title"), not a shape change.
    const prefix = leafPrefix(k, T.leaves);
    if (T.containers.has(k)) type(k);
    else if (prefix !== undefined && !S.leaves.has(prefix)) type(prefix);
    else if (pluralForm(k, S.leaves, locale, format) !== 'unused') add(k, 'missing', 'is missing');
  }
  for (const k of T.leaves.keys()) {
    if (S.leaves.has(k)) continue;
    const prefix = leafPrefix(k, S.leaves);
    if (S.containers.has(k)) type(k);
    else if (prefix !== undefined && !T.leaves.has(prefix)) type(prefix);
    else {
      const m = PLURAL_KEY.exec(k);
      const sourcePlural = format === 'i18next' && m && isPluralSet(`${m[1]}${m[2] ?? ''}`, S.leaves);
      const allowed = sourcePlural && (pluralForm(k, T.leaves, locale, format) === 'used' || (m[3] === 'zero' && !m[2]));
      if (!allowed) add(k, 'extra', 'is not in the source; remove it or add it to the source');
    }
  }
  // Plural forms the target language needs that the source lacks (ru _few/_many, ar _two). A warning,
  // because i18next falls back to _other; some, like fr _many, only show for counts in the millions.
  if (format === 'i18next' && !sameLanguage) {
    for (const k of S.leaves.keys()) {
      const m = PLURAL_KEY.exec(k);
      if (!m || m[3] !== 'other') continue;
      const base = `${m[1]}${m[2] ?? ''}`;
      const cats = pluralCategories(locale, m[2] ? 'ordinal' : 'cardinal') ?? new Set<string>();
      if (!isPluralSet(base, S.leaves) || ![...cats].some((c) => T.leaves.has(`${base}_${c}`))) continue; // whole set missing: reported above
      for (const cat of cats) {
        const need = `${base}_${cat}`;
        if (!S.leaves.has(need) && !T.leaves.has(need)) add(need, 'missing', `is missing; ${locale} uses the "${cat}" plural form`, 'warning');
      }
    }
  }
  return out;
}

// Compares every target locale with the source, file by file (namespace by namespace).
export function compare(sources: LocaleFile[], targets: LocaleFile[]): Finding[] {
  const findings: Finding[] = [];
  const parsedSources = sources.map((f) => parse(f, findings));
  const format = detectFormat(parsedSources.filter((p): p is Parsed => !!p));
  const locales = [...new Set(targets.map((t) => t.locale))];
  for (const locale of locales) {
    const mine = targets.filter((t) => t.locale === locale);
    for (const [i, src] of sources.entries()) {
      const tgt = mine.find((t) => t.ns === src.ns);
      if (!tgt) {
        const file = join(dirname(mine[0].file), basename(src.file));
        findings.push({ file, locale, rule: 'missing', severity: 'error', message: `file is missing (${src.file} has no ${locale} copy)` });
        continue;
      }
      const s = parsedSources[i];
      const t = parse(tgt, findings);
      if (s && t) findings.push(...comparePair(s, t, format));
    }
    for (const t of mine) {
      if (!sources.some((s) => s.ns === t.ns)) {
        findings.push({ file: t.file, locale, rule: 'extra', severity: 'warning', message: 'file has no source copy' });
      }
    }
  }
  return findings;
}

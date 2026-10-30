import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argNames, classify, compare, MAX_KEYS, tags, type Finding } from './drift.js';

const en = (o: unknown) => ({ file: 'en.json', locale: 'en', text: JSON.stringify(o) });
const ms = (o: unknown) => ({ file: 'ms.json', locale: 'ms', text: JSON.stringify(o) });
const run = (s: unknown, t: unknown) => compare([en(s)], [ms(t)]);
const rules = (f: Finding[]) => f.map((x) => `${x.key ?? '-'}:${x.rule}`).sort();

test('a clean en/ms pair has no findings, including BM loanwords and ms plurals with only "other"', () => {
  const s = { nav: { home: 'Home', status: 'Status', email: 'Email' }, ok: 'OK', n: '{count, plural, one {# item} other {# items}}' };
  const t = { nav: { home: 'Utama', status: 'Status', email: 'Email' }, ok: 'OK', n: '{count, plural, other {# item}}' };
  assert.deepEqual(run(s, t), []);
});

test('missing and extra keys, at any depth', () => {
  assert.deepEqual(rules(run({ a: 'Hi', b: { c: 'Bye now' } }, { a: 'Hai', z: 'stale' })), ['b.c:missing', 'z:extra']);
  const f = run({ a: 'Hi', b: 'Yo' }, { a: 'Hai', c: 'x' });
  const m = f.find((x) => x.rule === 'missing')!;
  assert.equal(f.find((x) => x.rule === 'extra')!.severity, 'warning');
  assert.equal(m.severity, 'error');
  assert.equal(m.file, 'ms.json');
});

test('type mismatch between a string and an object is reported once, not as missing + extra', () => {
  assert.deepEqual(rules(run({ a: 'Text', b: { c: 'x y' } }, { a: { deep: 'Teks' }, b: 'teks' })), ['a:type', 'b:type']);
  assert.deepEqual(rules(run({ n: 'One two' }, { n: 5 })), ['n:type']);
});

test('arrays are compared per item', () => {
  assert.deepEqual(rules(run({ steps: ['Open the app', 'Tap pay'] }, { steps: ['Buka aplikasi'] })), ['steps.1:missing']);
});

test('ICU argument names come from every branch; branch text and # are not arguments', () => {
  assert.deepEqual([...argNames('{count, plural, one {# Item} other {# Items}}', 'icu').names].sort(), ['count']);
  assert.deepEqual([...argNames('{g, select, male {He met {who}} other {They}}', 'icu').names].sort(), ['g', 'who']);
  assert.deepEqual([...argNames('Total: {amount, number, ::currency/MYR}', 'icu').names], ['amount']);
  assert.deepEqual([...argNames("It''s '{literal}' {name}", 'icu').names], ['name']);
  assert.equal(argNames('Hi {name', 'icu').ok, false);
});

test('i18next interpolation is normalised: {{- x}}, {{x, format}} and $t(key)', () => {
  assert.deepEqual([...argNames('{{- name}} paid {{amount, currency}} $t(common.rm)', 'i18next').names].sort(), ['$t(common.rm)', 'amount', 'name']);
});

test('placeholder mismatch is an error; reordering is fine', () => {
  assert.deepEqual(run({ g: 'Hello {name}, you owe {amount}' }, { g: '{amount} terhutang, {name}' }), []);
  const [f] = run({ g: 'Hello {name}, you owe {amount}' }, { g: 'Hai {nama}, hutang {amount}' });
  assert.equal(f.rule, 'placeholder');
  assert.equal(f.severity, 'error');
  assert.match(f.message, /\{name\}/);
  assert.match(f.message, /\{nama\}/);
  assert.deepEqual(rules(run({ g: 'Hi {name}' }, { g: 'Hai {name' })), ['g:placeholder']);
});

test('i18next format is detected from the source and {{x}} is checked', () => {
  assert.deepEqual(rules(run({ g: 'Hello {{name}}' }, { g: 'Hai {{nama}}' })), ['g:placeholder']);
});

test('tags are compared as a multiset; attributes, numbered Trans tags and "a <5" are handled', () => {
  assert.deepEqual([...tags('Read <a href="/t">terms</a><br/> and <0>this</0> <1/>')].sort(), ['</0>', '</a>', '<0>', '<1/>', '<a>', '<br/>']);
  assert.deepEqual(tags('if a <5 and b >3'), []);
  assert.deepEqual(rules(run({ c: 'Pay <b>now</b>' }, { c: 'Bayar sekarang' })), ['c:tag']);
  assert.deepEqual(run({ c: 'Pay <b>now</b>' }, { c: 'Bayar <b>sekarang</b>' }), []);
});

test('untranslated: a copied sentence is flagged, single words, URLs, emails and placeholders are not', () => {
  const s = { a: 'Sign in to continue', b: 'Status', c: 'https://zaf.my', d: 'help@example.com', e: '{count}', f: 'v1.2.3', g: 'RM {amount}' };
  assert.deepEqual(rules(run(s, s)), ['a:untranslated']);
  const [f] = run({ a: 'Sign in to continue' }, { a: 'Sign in to continue' });
  assert.equal(f.severity, 'warning');
});

test('untranslated is skipped when target and source are the same language', () => {
  assert.deepEqual(compare([en({ a: 'Sign in now' })], [{ file: 'en-GB.json', locale: 'en-GB', text: '{"a":"Sign in now"}' }]), []);
});

test('empty target value is a warning, not also untranslated', () => {
  assert.deepEqual(rules(run({ a: 'Sign in now' }, { a: '' })), ['a:empty']);
});

test('i18next plural keys follow the target language (CLDR): ms needs only _other', () => {
  const s = { item_one: '{{count}} item', item_other: '{{count}} items', place_ordinal_one: '{{count}}st', place_ordinal_other: '{{count}}th' };
  assert.deepEqual(run(s, { item_other: '{{count}} item', place_ordinal_one: 'ke-{{count}}', place_ordinal_other: 'ke-{{count}}' }), []);
  assert.deepEqual(rules(run(s, { item_one: '{{count}} item', place_ordinal_other: 'ke-{{count}}' })), ['item_other:missing', 'place_ordinal_one:missing']);
  // A normal key that just ends in _one is not a plural.
  assert.deepEqual(rules(run({ step_one: 'First step' }, {})), ['step_one:missing']);
});

test('invalid JSON is one finding per file, and the other files are still checked', () => {
  const f = compare([en({ a: 'Hi there' })], [{ file: 'ms.json', locale: 'ms', text: '{"a": "Hai",}' }, { file: 'id.json', locale: 'id', text: '{}' }]);
  assert.deepEqual(f.map((x) => `${x.file}:${x.rule}`), ['ms.json:invalid-json', 'id.json:missing']);
});

test('namespaced layout: a missing namespace file is one finding, keys are prefixed ns:key', () => {
  const src = [{ file: 'en/common.json', locale: 'en', ns: 'common', text: '{"hi":"Hi there"}' }, { file: 'en/auth.json', locale: 'en', ns: 'auth', text: '{"in":"Sign in now"}' }];
  const f = compare(src, [{ file: 'ms/common.json', locale: 'ms', ns: 'common', text: '{}' }]);
  assert.deepEqual(f.map((x) => `${x.file}|${x.key ?? '-'}|${x.rule}`).sort(), ['ms/auth.json|-|missing', 'ms/common.json|common:hi|missing']);
});

test('more than MAX_KEYS keys throws instead of silently truncating', () => {
  const big = Object.fromEntries(Array.from({ length: MAX_KEYS + 1 }, (_, i) => [`k${i}`, 'x']));
  const ok = Object.fromEntries(Array.from({ length: MAX_KEYS }, (_, i) => [`k${i}`, 'x']));
  assert.doesNotThrow(() => compare([en(ok)], [ms(ok)]));
  assert.throws(() => compare([en(big)], [ms({})]), /5000/);
});

test('classify reads locale and namespace from the path', () => {
  assert.deepEqual(classify('messages/ms.json'), { locale: 'ms' });
  assert.deepEqual(classify('src/locales/ms-MY.json'), { locale: 'ms-MY' });
  assert.deepEqual(classify('public/locales/ms/common.json'), { locale: 'ms', ns: 'common' });
  assert.equal(classify('package.json'), undefined);
  assert.equal(classify('src/i18n/config.json'), undefined);
});

// CLI tests run the built entry point against temp folders.
const cli = fileURLToPath(new URL('./index.js', import.meta.url));
const exec = (args: string[], opts: { cwd?: string; input?: string } = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', ...opts });
function project(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'locale-drift-'));
  for (const [p, v] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), typeof v === 'string' ? v : JSON.stringify(v));
  }
  return dir;
}

test('cli: auto-discovers messages/, exit 1 on errors, --json shape, --ignore and --strict', () => {
  const dir = project({ 'messages/en.json': { a: 'Hi {name}', b: 'Sign in now' }, 'messages/ms.json': { a: 'Hai', b: 'Sign in now' } });
  const t = exec([], { cwd: dir });
  assert.equal(t.status, 1, t.stderr);
  assert.match(t.stdout, /messages\/ms\.json/);
  assert.match(t.stdout, /\[placeholder\]/);
  const j = JSON.parse(exec(['--json'], { cwd: dir }).stdout);
  assert.equal(j.version, 1);
  assert.equal(j.ok, false);
  assert.equal(j.source, 'en');
  assert.deepEqual(j.summary, { errors: 1, warnings: 1 });
  assert.deepEqual(j.findings.map((f: Finding) => f.rule).sort(), ['placeholder', 'untranslated']);
  assert.equal(exec(['--ignore', 'placeholder'], { cwd: dir }).status, 0);
  assert.equal(exec(['--ignore', 'placeholder', '--strict'], { cwd: dir }).status, 1);
  assert.equal(exec(['--ignore', 'nope'], { cwd: dir }).status, 2);
});

test('cli: explicit folder, --source, and usage errors exit 2', () => {
  const dir = project({ 'i18n/ms.json': { a: 'Hai semua' }, 'i18n/id.json': { a: 'Halo semua' } });
  assert.equal(exec(['i18n'], { cwd: dir }).status, 2, 'no en source');
  assert.equal(exec(['--source', 'ms', 'i18n'], { cwd: dir }).status, 0);
  assert.equal(exec([], { cwd: project({ 'README.md': 'x' }) }).status, 2);
});

test('cli: namespaced public/locales layout is discovered', () => {
  const dir = project({ 'public/locales/en/common.json': { hi: 'Hi there' }, 'public/locales/ms/common.json': { hi: 'Hai semua' } });
  const r = exec(['--json'], { cwd: dir });
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(JSON.parse(r.stdout).locales, ['en', 'ms']);
});

const hook = (cwd: string, file: string, extra: object = {}) =>
  exec(['--hook'], { input: JSON.stringify({ hook_event_name: 'PostToolUse', cwd, tool_name: 'Write', tool_input: { file_path: join(cwd, file) }, ...extra }) });

test('hook: an edited target with errors blocks with the reason on stdout, exit 0', () => {
  const dir = project({ 'messages/en.json': { a: 'Hi {name}', b: 'Sign in now' }, 'messages/ms.json': { a: 'Hai', b: 'Sign in now' } });
  const r = hook(dir, 'messages/ms.json');
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /\{name\}/);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(out.hookSpecificOutput.additionalContext, /untranslated/);
});

test('hook: warnings only add context without blocking', () => {
  const dir = project({ 'messages/en.json': { b: 'Sign in now' }, 'messages/ms.json': { b: 'Sign in now' } });
  const out = JSON.parse(hook(dir, 'messages/ms.json').stdout);
  assert.equal(out.decision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /untranslated/);
});

test('hook: silent for the source file, non-locale files, clean targets and garbage stdin', () => {
  const dir = project({ 'messages/en.json': { a: 'Hi {name}' }, 'messages/ms.json': { a: 'Hai' }, 'package.json': {} });
  for (const f of ['messages/en.json', 'package.json', 'src/app.ts']) {
    const r = hook(dir, f);
    assert.equal(r.status, 0, f);
    assert.equal(r.stdout, '', f);
  }
  const clean = project({ 'messages/en.json': { a: 'Hi {name}' }, 'messages/ms.json': { a: 'Hai {name}' } });
  assert.equal(hook(clean, 'messages/ms.json').stdout, '');
  const g = exec(['--hook'], { input: 'not json' });
  assert.equal(g.status, 0);
  assert.equal(g.stdout, '');
  // Cursor puts file_path at the top level.
  const cursor = exec(['--hook'], { input: JSON.stringify({ cwd: dir, file_path: join(dir, 'messages/ms.json') }) });
  assert.equal(JSON.parse(cursor.stdout).decision, 'block');
});

test('hook: namespaced file is checked only against its own namespace', () => {
  const dir = project({
    'public/locales/en/common.json': { hi: 'Hi {{name}}' }, 'public/locales/en/auth.json': { in: 'Sign in now' },
    'public/locales/ms/common.json': { hi: 'Hai {{name}}' },
  });
  assert.equal(hook(dir, 'public/locales/ms/common.json').stdout, '');
});

// Regressions found in adversarial review.
test('review: an ICU plural branch that starts with an argument stays ICU, so other placeholders are still checked', () => {
  const s = { p: '{n, plural, one {{name} liked this} other {{name} and # others liked this}}', b: 'Hello {name}' };
  const t = { p: '{n, plural, other {{name} dan # lagi suka ini}}', b: 'Helo {nama}' };
  assert.deepEqual(rules(run(s, t)), ['b:placeholder']);
});

test('review: $t() without {{ }} is still i18next, so a dropped $t() is caught', () => {
  assert.deepEqual(rules(run({ a: 'See $t(common.terms) first' }, { a: 'Lihat dahulu' })), ['a:placeholder']);
});

test('review: tags inside plural branches compare as a set, so ms with only "other" is fine', () => {
  assert.deepEqual(run({ a: '{n, plural, one {<b>#</b> item} other {<b>#</b> items}}' }, { a: '{n, plural, other {<b>#</b> item}}' }), []);
});

test("review: '' inside an ICU quoted literal does not end the quote", () => {
  assert.deepEqual(argNames("'{it''s}' ok", 'icu'), { names: new Set(), ok: true });
});

test('review: a copied ICU plural/select message is untranslated; a wordless one is not', () => {
  const copy = { a: '{count, plural, one {# new message} other {# new messages}}', g: '{g, select, male {He replied to you} other {They replied to you}}', n: '{n, plural, one {#} other {#}}' };
  assert.deepEqual(rules(run(copy, copy)), ['a:untranslated', 'g:untranslated']);
});

test('review: <br /> and <br/> are the same tag', () => {
  assert.deepEqual(tags('a<br />b'), ['<br/>']);
  assert.deepEqual(run({ a: 'Line one<br/>Line two' }, { a: 'Baris satu<br />Baris dua' }), []);
});

test('review: react-intl flat dotted keys: a missing one is missing, not a type mismatch', () => {
  assert.deepEqual(rules(run({ home: 'Home', 'home.title': 'Welcome back' }, { home: 'Utama' })), ['home.title:missing']);
  assert.deepEqual(rules(run({ home: 'Home' }, { home: 'Utama', 'home.title': 'Selamat kembali' })), ['home.title:extra']);
});

test('review: an i18next _zero form only in the target is allowed', () => {
  assert.deepEqual(run({ item_one: '{{count}} item', item_other: '{{count}} items' }, { item_zero: 'Tiada item', item_other: '{{count}} item' }), []);
});

test('review: classify reads the file name first, so a folder called src is not a locale', () => {
  assert.deepEqual(classify('src/ms.json'), { locale: 'ms' });
  assert.deepEqual(classify('src/en.json'), { locale: 'en' });
  assert.deepEqual(classify('public/locales/ms/common.json'), { locale: 'ms', ns: 'common' });
});

test('review: a different script is a different language (zh-Hans vs zh-Hant); a region is not', () => {
  const zh = (l: string) => ({ file: `${l}.json`, locale: l, text: '{"a":"欢迎回来 朋友"}' });
  assert.deepEqual(rules(compare([zh('zh-Hans')], [zh('zh-Hant')])), ['a:untranslated']);
  assert.deepEqual(compare([en({ a: 'Sign in now' })], [{ file: 'en-GB.json', locale: 'en-GB', text: '{"a":"Sign in now"}' }]), []);
});

test('review: the 5 MB limit counts bytes, not characters', () => {
  const text = JSON.stringify({ a: 'é'.repeat(2_600_000) }); // ~5.2 MB in UTF-8, ~2.6M chars
  assert.throws(() => compare([{ file: 'en.json', locale: 'en', text }], [ms({ a: 'x' })]), /MB/);
});

test('review cli: src/en.json + src/ms.json are found; duplicate locales exit 2; discovery skips a folder with only the source', () => {
  const dir = project({ 'src/en.json': { a: 'Hi {name}' }, 'src/ms.json': { a: 'Hai' } });
  assert.equal(exec(['src'], { cwd: dir }).status, 1);
  const dup = project({ 'a/en.json': { a: 'Hi' }, 'a/ms.json': { a: 'Hai' }, 'b/ms.json': { a: 'x' } });
  assert.equal(exec(['a', 'b'], { cwd: dup }).status, 2);
  const dupSrc = project({ 'a/en.json': { a: 'Hi' }, 'b/en.json': { b: 'Yo' }, 'a/ms.json': { a: 'Hai' } });
  assert.equal(exec(['a', 'b'], { cwd: dupSrc }).status, 2);
  const two = project({ 'messages/en.json': { a: 'Hi' }, 'public/locales/en/common.json': { a: 'Hi {name}' }, 'public/locales/ms/common.json': { a: 'Hai' } });
  const r = exec(['--json'], { cwd: two });
  assert.equal(r.status, 1, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).locales, ['en', 'ms']);
});

test('review hook: bad flags exit 0; an invalid source never blocks the target; limits are reported', () => {
  const dir = project({ 'messages/en.json': '{"a": "Hi",}', 'messages/ms.json': { a: 'Hai' } });
  assert.equal(exec(['--hook', '--ignore', 'nope'], { input: '{}' }).status, 0);
  assert.equal(exec(['--hook', '--bogus'], { input: '{}' }).status, 0);
  assert.equal(hook(dir, 'messages/ms.json').stdout, '');
  const big = Object.fromEntries(Array.from({ length: MAX_KEYS + 1 }, (_, i) => [`k${i}`, 'x']));
  const lim = project({ 'messages/en.json': big, 'messages/ms.json': {} });
  const out = JSON.parse(hook(lim, 'messages/ms.json').stdout);
  assert.equal(out.decision, undefined);
  assert.match(out.hookSpecificOutput.additionalContext, /5000/);
});

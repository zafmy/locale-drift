#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { classify, compare, isLocale, MAX_TARGETS, RULES, type Finding, type LocaleFile } from './drift.js';

const FOLDERS = ['messages', 'locales', 'src/locales', 'src/i18n', 'src/lang', 'i18n', 'lang', 'public/locales'];
const USAGE = `Usage: locale-drift [--source <locale>] [--json] [--strict] [--ignore <rule>]... [path...]
       locale-drift --hook [--source <locale>]   (Claude Code / Codex / Cursor PostToolUse hook)

Compares each locale JSON file with the source locale (default: en).
Paths can be locale files or folders. With none, looks in: ${FOLDERS.join(', ')}.
  --source  the locale the others are translated from
  --strict  fail on warnings too
  --ignore  skip a rule; repeatable. Rules: ${RULES.join(', ')}
  --json    print the report as JSON, for agents and scripts
  --hook    read a hook event on stdin and report on the edited locale file only

Exit codes: 0 no errors, 1 an error (or a warning with --strict), 2 bad usage or no locale files found.
In --hook mode it always exits 0; findings go back to the agent as JSON on stdout.`;

// In --hook mode exit 2 would be fed to the agent as if it broke a translation, so a bad setup exits 0.
const HOOK = process.argv.includes('--hook');
const die = (msg: string): never => {
  process.stderr.write(HOOK ? `locale-drift --hook: ${msg}\n` : `locale-drift: ${msg}\n\n${USAGE}\n`);
  process.exit(HOOK ? 0 : 2);
};

function readArgs() {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        source: { type: 'string', default: 'en' },
        json: { type: 'boolean', default: false },
        strict: { type: 'boolean', default: false },
        hook: { type: 'boolean', default: false },
        ignore: { type: 'string', multiple: true, default: [] },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (e) {
    return die(e instanceof Error ? e.message : String(e));
  }
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

// Locale files in a folder: <locale>.json, or <locale>/<namespace>.json.
function inFolder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (isDir(p) && isLocale(name)) out.push(...readdirSync(p).sort().filter((f) => f.endsWith('.json')).map((f) => join(p, f)));
    else if (classify(p)) out.push(p);
  }
  return out;
}

const read = (path: string, display: string): LocaleFile => {
  const c = classify(path);
  if (!c) return die(`${display} is not named after a locale (like ms.json or ms/common.json)`);
  try {
    return { file: display, text: readFileSync(path, 'utf8'), ...c };
  } catch (e) {
    return die(`cannot read ${display}: ${e instanceof Error ? e.message : String(e)}`);
  }
};

const { values, positionals } = readArgs();
if (values.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}
const ignored = new Set<string>(values.ignore);
for (const rule of ignored) if (!(RULES as readonly string[]).includes(rule)) die(`unknown rule "${rule}"`);
const keep = (f: Finding) => !ignored.has(f.rule);
const line = (f: Finding) => `${f.key ? `${f.key}: ` : ''}${f.message} [${f.rule}]`;

// Hook mode never fails the agent's tool call: anything unexpected exits 0 quietly.
function hook(source: string): void {
  let input: Record<string, any>;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  const edited = input?.tool_input?.file_path ?? input?.file_path;
  if (typeof edited !== 'string') return;
  const cwd = typeof input.cwd === 'string' ? input.cwd : process.cwd();
  const target = resolve(cwd, edited);
  const c = classify(target);
  if (!c || c.locale === source) return;
  const sourcePath = c.ns ? join(dirname(dirname(target)), source, basename(target)) : join(dirname(target), `${source}.json`);
  if (!existsSync(sourcePath)) return;
  const shown = (p: string) => relative(cwd, p) || p;
  const pair = [{ file: shown(sourcePath), text: readFileSync(sourcePath, 'utf8'), ...classify(sourcePath)! }];
  const written = { file: shown(target), text: readFileSync(target, 'utf8'), ...c };
  const head = `locale-drift: ${shown(target)} vs ${shown(sourcePath)}`;
  // Over a limit or a broken source: say why it was skipped rather than go quiet, but don't block.
  const skipped = (why: string): void => void process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: `${head}\nskipped: ${why}` } })}\n`);
  let all: Finding[];
  try {
    // Every source namespace decides the syntax, as in a full run, so hook and CLI agree.
    const siblings = c.ns ? readdirSync(dirname(sourcePath)).filter((f) => f.endsWith('.json')).map((f) => join(dirname(sourcePath), f)) : [sourcePath];
    const detectFrom = siblings.map((p) => ({ file: shown(p), text: readFileSync(p, 'utf8'), ...classify(p)! }));
    all = compare(pair, [written], detectFrom);
  } catch (e) {
    return skipped(e instanceof Error ? e.message : String(e));
  }
  const targetBroken = all.some((f) => f.file === written.file && f.rule === 'invalid-json');
  if (!targetBroken && all.some((f) => f.file === pair[0].file && f.rule === 'invalid-json')) return skipped(`${pair[0].file} is not valid JSON`);
  // Only the file the agent just wrote: a broken source is not this edit's fault.
  const findings = all.filter((f) => f.file === written.file).filter(keep);
  if (!findings.length) return;
  let text = head;
  for (const [i, f] of findings.entries()) {
    const next = `${text}\n- ${line(f)}`;
    if (next.length > 8000) {
      text += `\n…and ${findings.length - i} more; run locale-drift for the full list`;
      break;
    }
    text = next;
  }
  const errors = findings.some((f) => f.severity === 'error');
  const out = { ...(errors && { decision: 'block', reason: text }), hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: text } };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

if (values.hook) {
  try {
    hook(values.source);
  } catch {
    // A half-written file or a race with a formatter: stay quiet, the next edit runs again.
  }
  process.exit(0);
}

// With no paths, the first known folder that has the source and at least one other locale.
const comparable = (f: string[]) => {
  const locales = f.map((p) => classify(p)?.locale);
  return locales.includes(values.source) && locales.some((l) => l !== values.source);
};
const paths = positionals.length
  ? positionals.flatMap((p) => (isDir(p) ? inFolder(p) : [p]))
  : (FOLDERS.filter(isDir).map(inFolder).find(comparable) ?? FOLDERS.filter(isDir).map(inFolder).find((f) => f.length) ?? []);
if (!paths.length) die(positionals.length ? 'no locale files in the given paths' : `no locale files found in ${FOLDERS.join(', ')}; pass a folder or files`);
const files = paths.map((p) => read(p, p));
const seen = new Map<string, string>();
for (const f of files) {
  const id = `${f.locale}${f.ns ? `/${f.ns}` : ''}`;
  if (seen.has(id)) die(`${id} is given twice (${seen.get(id)}, ${f.file}); check one folder at a time`);
  seen.set(id, f.file);
}
const locales = [...new Set(files.map((f) => f.locale))];
const sources = files.filter((f) => f.locale === values.source);
const targets = files.filter((f) => f.locale !== values.source);
if (!sources.length) die(`no "${values.source}" source locale; found ${locales.join(', ')}. Pick one with --source`);
if (!targets.length) die(`only the source locale "${values.source}" was found; nothing to compare`);
if (locales.length - 1 > MAX_TARGETS) die(`${locales.length - 1} target locales; locale-drift checks up to ${MAX_TARGETS} per run`);

let all: Finding[] = [];
try {
  all = compare(sources, targets);
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
const findings = all.filter(keep);
const errors = findings.filter((f) => f.severity === 'error').length;
const warnings = findings.length - errors;
const shownFiles = [...new Set([...targets.map((t) => t.file), ...findings.map((f) => f.file)])];
// Targets whose source file did not parse were never compared, so they must not look clean.
// Read from all findings, so --ignore invalid-json cannot turn an unchecked target into a pass.
const brokenSources = sources.filter((s) => all.some((f) => f.file === s.file && f.rule === 'invalid-json'));
const unchecked = targets.filter((t) => brokenSources.some((s) => s.ns === t.ns)).map((t) => t.file);
const ok = errors === 0 && unchecked.length === 0 && (!values.strict || warnings === 0);

function text(): string {
  const lines: string[] = [];
  for (const file of shownFiles) {
    const mine = findings.filter((f) => f.file === file);
    if (!mine.length && unchecked.includes(file)) {
      lines.push(`- ${file} (not checked: its source is not valid JSON)`);
      continue;
    }
    lines.push(`${mine.length ? '✖' : '✔'} ${file}`);
    lines.push(...mine.map((f) => `  ${f.severity === 'error' ? 'error' : 'warn '} ${line(f)}`));
  }
  lines.push(`${locales.length - 1} locale(s) vs ${values.source}: ${errors} error(s), ${warnings} warning(s)`);
  return lines.join('\n');
}

const report = { version: 1, ok, source: values.source, locales, files: shownFiles, unchecked, summary: { errors, warnings }, findings };
const out = values.json ? JSON.stringify(report, null, 2) : text();
process.stdout.write(`${out}\n`, () => process.exit(ok ? 0 : 1));

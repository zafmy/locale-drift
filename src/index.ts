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

const die = (msg: string): never => {
  process.stderr.write(`locale-drift: ${msg}\n\n${USAGE}\n`);
  process.exit(2);
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
  const findings = compare([{ file: shown(sourcePath), text: readFileSync(sourcePath, 'utf8'), ...classify(sourcePath)! }], [{ file: shown(target), text: readFileSync(target, 'utf8'), ...c }]).filter(keep);
  if (!findings.length) return;
  const head = `locale-drift: ${shown(target)} vs ${shown(sourcePath)}`;
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

const paths = positionals.length
  ? positionals.flatMap((p) => (isDir(p) ? inFolder(p) : [p]))
  : (FOLDERS.filter(isDir).map(inFolder).find((f) => f.length) ?? []);
if (!paths.length) die(positionals.length ? 'no locale files in the given paths' : `no locale files found in ${FOLDERS.join(', ')}; pass a folder or files`);
const files = paths.map((p) => read(p, p));
const locales = [...new Set(files.map((f) => f.locale))];
const sources = files.filter((f) => f.locale === values.source);
const targets = files.filter((f) => f.locale !== values.source);
if (!sources.length) die(`no "${values.source}" source locale; found ${locales.join(', ')}. Pick one with --source`);
if (!targets.length) die(`only the source locale "${values.source}" was found; nothing to compare`);
if (locales.length - 1 > MAX_TARGETS) die(`${locales.length - 1} target locales; locale-drift checks up to ${MAX_TARGETS} per run`);

let findings: Finding[] = [];
try {
  findings = compare(sources, targets).filter(keep);
} catch (e) {
  die(e instanceof Error ? e.message : String(e));
}
const errors = findings.filter((f) => f.severity === 'error').length;
const warnings = findings.length - errors;
const ok = errors === 0 && (!values.strict || warnings === 0);
const shownFiles = [...new Set([...targets.map((t) => t.file), ...findings.map((f) => f.file)])];

function text(): string {
  const lines: string[] = [];
  for (const file of shownFiles) {
    const mine = findings.filter((f) => f.file === file);
    lines.push(`${mine.length ? '✖' : '✔'} ${file}`);
    lines.push(...mine.map((f) => `  ${f.severity === 'error' ? 'error' : 'warn '} ${line(f)}`));
  }
  lines.push(`${locales.length - 1} locale(s) vs ${values.source}: ${errors} error(s), ${warnings} warning(s)`);
  return lines.join('\n');
}

const report = { version: 1, ok, source: values.source, locales, files: shownFiles, summary: { errors, warnings }, findings };
const out = values.json ? JSON.stringify(report, null, 2) : text();
process.stdout.write(`${out}\n`, () => process.exit(ok ? 0 : 1));

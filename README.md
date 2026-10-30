# locale-drift

[![CI](https://github.com/zafmy/locale-drift/actions/workflows/ci.yml/badge.svg)](https://github.com/zafmy/locale-drift/actions/workflows/ci.yml)

Check the translations your AI agent just wrote. It compares each JSON locale file with the source (`en.json` by default) and reports missing keys, English sentences copied without translating, placeholders and tags that got dropped or renamed, and keys that changed shape.

It reads files only. No network, no model, no config file, no runtime dependencies.

```text
$ npx -y github:zafmy/locale-drift
✖ messages/ms.json
  error greeting: missing {name}; unexpected {nama} [placeholder]
  warn  cart.empty: is the same as the source; translate it or --ignore untranslated [untranslated]
  error cart.checkout: missing </b> <b> [tag]
  error support: is missing [missing]
  warn  old: is not in the source; remove it or add it to the source [extra]
1 locale(s) vs en: 3 error(s), 2 warning(s)
```

## Why another i18n checker

Missing keys and ICU syntax are well covered already ([i18next-cli](https://github.com/i18next/i18next-cli) `lint`, [@lingual/i18n-check](https://github.com/lingualdev/i18n-check), [inlang](https://inlang.com) `check`). locale-drift is for the agent edit loop:

- **Copied English.** When an agent runs out of steam it pastes the source text into `ms.json`. locale-drift flags a value that is identical to the source and still has two or more words once placeholders, tags, links and numbers are removed. Single words are left alone, because Bahasa Melayu (and many other languages) keep loanwords like Status, Email, Data and Video.
- **Plurals by the target language.** Malay has one plural form (`other`), so an i18next `ms.json` with `item_other` and no `item_one` is correct. locale-drift reads the target's forms from `Intl.PluralRules`, the same CLDR data i18next uses.
- **A hook for agents.** `--hook` runs after each edit in Claude Code, Codex or Cursor and tells the agent what it broke in the file it just wrote, before it moves on.
- **Never stops on one bad file.** Invalid JSON is a finding for that file; the other locales are still checked.

## Use

```bash
npx -y github:zafmy/locale-drift              # looks in messages/, locales/, src/locales/, src/i18n/, i18n/, public/locales/ ...
npx -y github:zafmy/locale-drift src/i18n     # a folder
npx -y github:zafmy/locale-drift --source ms  # translate from Malay instead of English
npx -y github:zafmy/locale-drift --json       # for agents and scripts
```

It finds `<locale>.json` files (`messages/ms.json`, `locales/ms-MY.json`) and namespaced folders (`public/locales/ms/common.json`). File names must be real locale codes, so `app.json` or `config.json` next to them are skipped.

| Flag | |
|---|---|
| `--source <locale>` | the locale the others are translated from. Default `en` |
| `--strict` | fail on warnings too |
| `--ignore <rule>` | skip a rule; repeatable |
| `--json` | one JSON object on stdout: `{version, ok, source, locales, files, summary, findings}` |
| `--hook` | agent hook mode, see below |

Exit codes: 0 no errors, 1 an error (or a warning with `--strict`), 2 bad usage, no locale files, or over a limit.

## Rules

| Rule | Severity | Finds |
|---|---|---|
| `missing` | error | A source key, or a whole namespace file, that the target lacks. Plural forms the target language does not use are not required |
| `extra` | warning | A key only the target has, usually a renamed or stale key |
| `type` | error | A string on one side and an object, array or number on the other |
| `placeholder` | error | ICU `{name}` / i18next `{{name}}` / `$t(key)` arguments that differ, or unbalanced braces. Order doesn't matter, and plural/select branch text is not an argument |
| `tag` | error | `<b>`, `<a href>`, `<br/>` or react-i18next `<0>` tags that differ. Attributes are ignored |
| `untranslated` | warning | A value identical to the source with 2+ words. Skipped when both locales are the same language (`en` and `en-GB`) |
| `empty` | warning | An empty string where the source has text |
| `invalid-json` | error | A file that isn't valid JSON |

The placeholder syntax is detected from the source: i18next if any value uses `{{…}}`, otherwise ICU (next-intl, react-intl, FormatJS, and vue-i18n's `{name}`).

## Agent hook

Add this to `.claude/settings.json`. Codex and Cursor accept the same command in their own hook files; locale-drift reads `tool_input.file_path` or a top-level `file_path`.

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "npx -y github:zafmy/locale-drift#v0.1.0 --hook", "timeout": 15 }]
      }
    ]
  }
}
```

When the agent edits a target locale file, locale-drift compares that one file with its source and prints the result as hook JSON: errors block with a `reason` the agent reads, warnings are added as context. It stays silent for the source file, for files that aren't locale files, and for clean results, and always exits 0, so a half-written file never breaks the agent's turn. For speed on every edit, install it once (`npm i -D github:zafmy/locale-drift#v0.1.0`) and use `npx locale-drift --hook`.

## In CI

```yaml
- run: npx -y github:zafmy/locale-drift#v0.1.0 --strict
```

## Scope

JSON locale files only, up to 5000 keys per file, 10 target locales per run and 5 MB per file. Over a limit it stops with exit 2 rather than checking part of the file. It does not validate full ICU syntax, plural branch completeness, unused keys in your code, or translation quality, and it never translates anything. For deep ICU and plural checks use i18next-cli `lint` or inlang `check` alongside it.

## Develop

```bash
npm install
npm test
```

## License

MIT

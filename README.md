# supercode-autoinvoke-skill-gate

OpenCode `v1` plugin that hides Explicit-only skills from the model-facing `<available_skills>` catalog. A skill marked with `disable-model-invocation: true` (YAML boolean) in its `SKILL.md` frontmatter is removed from the catalog so the model does not auto-select it. Ordinary skills stay, explicit `/skill-name` and `skill({ name })` calls remain allowed.

## Install

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["supercode-autoinvoke-skill-gate"]
}
```

Or with npm auto-install:

```json
{
  "plugin": ["supercode-autoinvoke-skill-gate@latest"]
}
```

Restart OpenCode after saving.

> **Order:** This plugin must be the **last** `prompt-transform` plugin in your `plugin` list. A later `experimental.chat.system.transform` can re-inject the catalog after filtering.

## What it does

- Hooks `experimental.chat.system.transform` only.
- Parses each `<available_skills>…</available_skills>` block, extracts `<location>` per `<skill>`, reads that `SKILL.md`, and drops the whole `<skill>` record when `disable-model-invocation: true` (unquoted YAML boolean). Neighbors, order, and surrounding system text stay byte-for-byte.
- Mutates `output.system` in place (array identity preserved, only catalog-containing elements changed).
- No `tool.execute.before` or invocation guard — explicit `/skill-name` and tool `skill` with a known name stay allowed.
- Missing catalog is a no-op. Filtering all records leaves an empty `<available_skills>\n</available_skills>` via the same generic path (no special branch/text).
- Happy path is silent: no log, no toast.

## Frontmatter

```md
---
name: my-private-skill
description: does a niche thing
disable-model-invocation: true
---
```

Only unquoted `true` counts. Quoted `"true"` / `'true'`, numbers, or other types do not hide the skill.

## Verify

```sh
npm test
```

Tests run via the Catalog Policy/Filter seam (`src/filter.js` + `src/policy.js`) without a live OpenCode server.

## Uninstall

Remove the package from `plugin` and restart OpenCode — native catalog behavior returns.

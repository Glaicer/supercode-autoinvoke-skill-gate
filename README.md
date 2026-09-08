# supercode-autoinvoke-skill-gate

OpenCode `v1` plugin that hides Explicit-only skills from the model-facing `<available_skills>` catalog. A skill carrying any one valid denying marker is removed from the catalog so the model does not auto-select it. Ordinary skills stay, explicit `/skill-name` and `skill({ name })` calls remain allowed.

## Install

Install with the OpenCode CLI:

```bash
opencode plugin @glaicer/supercode-autoinvoke-skill-gate
```

- `--global` installs into the global config (`~/.config/opencode`); default is local (`.opencode` in the current project).
- `--force` replaces an already-installed version.
- Restart OpenCode after installing.

Manual install also works: add the package to the `plugin` array in `opencode.json` (global `~/.config/opencode/opencode.json` or local `<project>/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@glaicer/supercode-autoinvoke-skill-gate"]
}
```

Restart OpenCode after saving.

> **Order:** This plugin must be the **last** `prompt-transform` plugin in your `plugin` list. A later `experimental.chat.system.transform` can re-inject the catalog after filtering.

## What it does

- Hooks `experimental.chat.system.transform` only — no `tool.execute.before` or invocation guard.
- Parses each `<available_skills>…</available_skills>` block, extracts `<name>` + `<location>` per `<skill>` (the OpenCode-selected records are the source of truth), and drops the whole `<skill>` record when it is Explicit-only.
- Mutates `output.system` in place (array identity preserved, only catalog-containing elements changed). Neighbors, order, and surrounding system text stay byte-for-byte.
- Missing catalog is a no-op. Filtering all records leaves an empty `<available_skills>\n</available_skills>` via the same generic path.
- Happy path is silent. Recoverable metadata warnings are deduped and logged; TUI toast is best-effort, headless fallback is the log.
- No configuration key — installing the package enables filtering, removing it restores native behavior.

## Portable markers (ANY denial)

Exactly three portable markers are recognized — all require YAML **boolean** `true`/`false` (quoted strings, numbers, `null`, arrays never coerce):

| Ecosystem | File | Field | Denying value |
| --- | --- | --- | --- |
| Claude Code | `SKILL.md` frontmatter | `disable-model-invocation` | `true` |
| Codex | adjacent `agents/openai.yaml` | `policy.allow_implicit_invocation` | `false` |
| OpenCode v2 compat | `SKILL.md` frontmatter | `metadata.opencode/autoinvoke` | `false` |

Any one valid denying value makes the **selected** `<name>` + `<location>` record Explicit-only. A valid allowing value (`false` / `true` / `true` respectively) from another ecosystem never cancels a valid denial and produces a single conflict warning; the record stays filtered.

Absent marker and absent optional `agents/openai.yaml` are normal (no warning). Malformed YAML, read errors, wrong type for a known field, and duplicate/ambiguous keys fail open for that marker and produce a deduplicated warning — a different valid denying marker on the same record still filters it.

Duplicate skill names with different `<location>` are distinct policy subjects. The duplicate copy on disk never classifies the selected record.

Location is resolved safely across symlink aliases (`realpath`): catalog identity stays the original `<location>`, metadata is read from the canonical file and its adjacent `agents/openai.yaml`.

## Snapshot

Policy is built lazily at the **first** model request that exposes the catalog. The snapshot covers the effective catalog identities present then and is immutable until the OpenCode process restarts:

- Edits made before the first request are included.
- Edits to `SKILL.md`, `agents/openai.yaml`, or the catalog after the snapshot are not reread.
- Identities not present in the first snapshot are preserved fail-open on later transforms and do not trigger a second scan.

## Frontmatter examples

```md
---
name: my-private-skill
description: does a niche thing
disable-model-invocation: true
---
```

```md
---
name: my-private-skill
description: does a niche thing
metadata:
  opencode/autoinvoke: false
---
```

`agents/openai.yaml` next to `SKILL.md`:

```yaml
policy:
  allow_implicit_invocation: false
```

Only unquoted booleans count. `disable-model-invocation: "true"` stays visible (with a warning).

## Verify

```sh
npm run typecheck
npm run build
npm test
npm run check:package
```

Sources are TypeScript (`src/*.ts`); the published artifact is compiled JavaScript (`dist/*.js`, built via `scripts/build.mjs` with Babel type-stripping).

Tests run uncompiled via Node 24 native type-stripping through the Catalog Policy/Filter seam (`src/filter.ts` + `src/policy.ts`) and cover: three markers, ANY-denial, conflicts, exact YAML boolean vs quoted/number/null/array, malformed/read errors, duplicate names with different locations, symlink alias (including the `createCatalogFilter(readFile, realpathFn)` overload), and immutable snapshot (unknown identities preserved fail-open).

## Uninstall

Remove the package from `plugin` and restart OpenCode — native catalog behavior returns.

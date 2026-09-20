import { readFile, realpath } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "@opencode/plugin";
import { createCatalogFilter, type SystemOutput } from "./filter.ts";
import { BUILTIN_LOCATION, classifyRecord } from "./policy.ts";

export const PLUGIN_ID = "autoinvoke-skill-gate";

async function readFileGeneric(filePath: string): Promise<string | undefined> {
  return await readFile(filePath, "utf8");
}

export interface GateHooks {
  "experimental.chat.system.transform": (input: unknown, output: SystemOutput) => Promise<void>;
}

export interface GateClient {
  app: {
    log: (input: unknown) => Promise<unknown> | unknown;
  };
}

export interface GateInput {
  client?: GateClient;
}

async function logWarnings(client: GateClient | undefined, warnings: string[]): Promise<void> {
  if (!client || warnings.length === 0) return;
  try {
    await client.app.log({
      body: {
        service: "autoinvoke-skill-gate",
        level: "warn",
        message: warnings.join("\n"),
      },
    });
  } catch {
    // best-effort: never break the hook because logging failed
  }
}

export async function createAutoinvokeGateHooks(input?: GateInput): Promise<GateHooks> {
  const client = input?.client;
  const filter = createCatalogFilter(readFileGeneric, {
    realpath,
    onWarnings: (warnings) => {
      void logWarnings(client, warnings);
    },
  });

  return {
    "experimental.chat.system.transform": async (_input: unknown, output: SystemOutput): Promise<void> => {
      await filter(output);
    },
  };
}

interface SkillRead {
  content?: string;
  error?: unknown;
  missing: boolean;
}

function tryReadSync(filePath: string): SkillRead {
  try {
    return { content: readFileSync(filePath, "utf8"), missing: false };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    if (code === "ENOENT") return { missing: true };
    return { error, missing: false };
  }
}

function skillFileAndDir(skillPath: string): { file: string; dir: string } {
  if (skillPath.endsWith(".md")) return { file: skillPath, dir: dirname(skillPath) };
  return { file: join(skillPath, "SKILL.md"), dir: skillPath };
}

function isBuiltinSkillPath(skillPath: string): boolean {
  return skillPath === "" || skillPath === BUILTIN_LOCATION || skillPath.startsWith("/builtin/");
}

/**
 * Sync classification for the V2 `skill.transform` hook, which is itself sync
 * and re-runs on every registry reload. Reads the raw SKILL.md from disk
 * because the registry `content` field is body-only (frontmatter stripped by
 * the native loader), so markers like `disable-model-invocation` are only
 * visible in the file. Fail-open: any read problem leaves the skill visible.
 */
function classifySkillSync(skillPath: string): { explicitOnly: boolean; warnings: string[] } {
  if (isBuiltinSkillPath(skillPath)) return { explicitOnly: false, warnings: [] };
  const { file, dir } = skillFileAndDir(skillPath);
  const skill = tryReadSync(file);
  const sidecar = tryReadSync(join(dir, "agents", "openai.yaml"));
  return classifyRecord({
    skillContent: skill.content,
    skillReadError: skill.content === undefined ? (skill.error ?? new Error(`missing SKILL.md at ${file}`)) : undefined,
    sidecarContent: sidecar.content,
    sidecarReadError: sidecar.error,
    sidecarMissing: sidecar.missing,
  });
}

interface SkillEditorLike {
  list: () => Array<{ id: string; path: string; autoinvoke?: boolean }>;
  update: (id: string, update: (skill: { autoinvoke?: boolean }) => void) => void;
}

interface SkillListLike {
  id?: unknown;
  path?: unknown;
}

function asListedSkills(listed: unknown): SkillListLike[] {
  if (Array.isArray(listed)) return listed as SkillListLike[];
  if (listed && typeof listed === "object" && Array.isArray((listed as { data?: unknown }).data)) {
    return (listed as { data: SkillListLike[] }).data;
  }
  return [];
}

function hasGlobalSkills(listed: unknown): boolean {
  return asListedSkills(listed).some(
    (skill) => typeof skill?.path === "string" && !isBuiltinSkillPath(skill.path),
  );
}

const LATE_PASS_POLL_MS = 250;
const LATE_PASS_TRIES = 80;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function setup(ctx: Plugin.Context): Promise<Plugin.Cleanup | void> {
  const warned = new Set<string>();
  const apply = (editor: SkillEditorLike): void => {
    for (const skill of editor.list()) {
      try {
        if (skill?.autoinvoke === false) continue;
        const id = typeof skill?.id === "string" ? skill.id : "";
        if (id === "") continue;
        const skillPath = typeof skill?.path === "string" ? skill.path : "";
        const { explicitOnly, warnings } = classifySkillSync(skillPath);
        for (const warning of warnings) {
          const message = `${id}: ${warning}`;
          if (!warned.has(message)) {
            warned.add(message);
            console.warn(`[${PLUGIN_ID}] ${message}`);
          }
        }
        if (!explicitOnly) continue;
        try {
          editor.update(id, (draft) => {
            draft.autoinvoke = false;
          });
        } catch {
          // fail-open: unknown id stays visible
        }
      } catch {
        // fail-open per skill: leave it visible
      }
    }
  };
  await ctx.skill.transform((editor) => {
    apply(editor as unknown as SkillEditorLike);
  });
  // Skills arrive after setup (at boot the registry holds builtins only) and
  // the built-in add-transform runs after transforms registered during setup,
  // so the pass above always sees an empty shelf. Once global skills are
  // listed, register again — a later registration runs after the add — and
  // reload so downstream skill guidance rebuilds from the hidden registry.
  let cancelled = false;
  void (async () => {
    for (let i = 0; i < LATE_PASS_TRIES && !cancelled; i++) {
      await sleep(LATE_PASS_POLL_MS);
      if (cancelled) return;
      let listed: unknown;
      try {
        listed = await ctx.skill.list();
      } catch {
        return;
      }
      if (!hasGlobalSkills(listed)) continue;
      try {
        await ctx.skill.transform((editor) => {
          apply(editor as unknown as SkillEditorLike);
        });
        await ctx.skill.reload();
      } catch {
        // fail-open: leave skills visible
      }
      return;
    }
  })();
  return () => {
    cancelled = true;
  };
}

// Dual V1/V2 entrypoint: V2 reads `id` + `setup` and ignores `server`;
// V1 (>=1.18.29) calls `server()`. Older V1 loaders use the named
// `createAutoinvokeGateHooks` function export. `@opencode/plugin` is a
// types-only devDependency, so this module stays runtime dependency-free.
export default {
  id: PLUGIN_ID,
  setup,
  async server(): Promise<GateHooks> {
    return createAutoinvokeGateHooks();
  },
};

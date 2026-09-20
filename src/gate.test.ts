import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as gateModule from "./gate.ts";
import { createAutoinvokeGateHooks, PLUGIN_ID, type GateInput } from "./gate.ts";
import type { SystemOutput } from "./filter.ts";

function skillEntry(name: string, description: string, location: string): string {
  return [
    "  <skill>",
    `    <name>${name}</name>`,
    `    <description>${description}</description>`,
    `    <location>${location}</location>`,
    "  </skill>",
  ].join("\n");
}

function catalog(entries: string[]): string {
  return ["<available_skills>", ...entries, "</available_skills>"].join("\n");
}

const MARKED_MD = `---\nname: hidden\ndescription: hidden\ndisable-model-invocation: true\n---\nbody`;
const UNMARKED_MD = `---\nname: visible\ndescription: visible\n---\nbody`;

test("default export is a V2 plugin definition with a V1 server() fallback", async () => {
  assert.equal(typeof gateModule.createAutoinvokeGateHooks, "function");
  const def = gateModule.default as {
    id?: unknown;
    setup?: unknown;
    server?: unknown;
  };
  assert.equal(def.id, PLUGIN_ID);
  assert.equal(typeof def.setup, "function");
  assert.equal(typeof def.server, "function");
  const hooks = (await (
    def.server as () => Promise<Record<string, unknown>>
  )()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(hooks), ["experimental.chat.system.transform"]);
});

test("legacy V1 loader shape (every function export invoked, deduped) instantiates exactly once", async () => {
  const seen = new Set<unknown>();
  const plugins: Array<(input: unknown) => Promise<unknown>> = [];
  for (const entry of Object.values(gateModule)) {
    if (typeof entry !== "function" || seen.has(entry)) continue;
    seen.add(entry);
    plugins.push(entry as (input: unknown) => Promise<unknown>);
  }
  assert.equal(plugins.length, 1);
  const hooks = (await (plugins[0] as (input: unknown) => Promise<Record<string, unknown>>)({})) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(hooks), ["experimental.chat.system.transform"]);
});

test("filter warnings reach client.app.log while fail-open keeps the skill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autoinvoke-gate-test-"));
  try {
    const skillPath = join(dir, "SKILL.md");
    await writeFile(skillPath, `---\nname: warn-skill\ndescription: warn\ndisable-model-invocation: "true"\n---\nbody`);
    const calls: unknown[] = [];
    const input: GateInput = {
      client: {
        app: {
          log: (entry: unknown) => {
            calls.push(entry);
            return Promise.resolve({});
          },
        },
      },
    };
    const hooks = await createAutoinvokeGateHooks(input);
    const output: SystemOutput = {
      system: [catalog([skillEntry("warn-skill", "warn", skillPath)])],
    };
    await hooks["experimental.chat.system.transform"]({}, output);
    await new Promise((resolve) => setImmediate(resolve));
    assert.match((output.system as string[])[0] as string, /warn-skill/);
    assert.equal(calls.length, 1);
    const body = (calls[0] as { body?: { service?: string; level?: string; message?: string } }).body ?? {};
    assert.equal(body.service, "autoinvoke-skill-gate");
    assert.equal(body.level, "warn");
    assert.match(body.message ?? "", /invalid type/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

interface FakeSkill {
  id: string;
  path: string;
  content?: string;
  autoinvoke?: boolean;
}

interface FakeEditor {
  skills: FakeSkill[];
  updates: Array<{ id: string; autoinvoke: unknown }>;
  list: () => FakeSkill[];
  update: (id: string, fn: (skill: { autoinvoke?: boolean }) => void) => void;
}

function makeEditor(skills: FakeSkill[]): FakeEditor {
  const editor: FakeEditor = {
    skills,
    updates: [],
    list: () => editor.skills,
    update(id: string, fn: (skill: { autoinvoke?: boolean }) => void) {
      const skill = editor.skills.find((s) => s.id === id);
      const draft: { autoinvoke?: boolean } = { autoinvoke: skill?.autoinvoke };
      fn(draft);
      if (skill) skill.autoinvoke = draft.autoinvoke;
      editor.updates.push({ id, autoinvoke: draft.autoinvoke });
    },
  };
  return editor;
}

function fakeCtx(editor: FakeEditor, listFn?: () => unknown): {
  ctx: {
    skill: {
      list: () => Promise<unknown>;
      transform: (cb: (editor: FakeEditor) => void) => Promise<void>;
      reload: () => Promise<void>;
    };
  };
  transformed: { value: boolean };
  captured: { cb: Array<(editor: FakeEditor) => void> };
  reloads: { count: number };
} {
  const transformed = { value: false };
  const captured: { cb: Array<(editor: FakeEditor) => void> } = { cb: [] };
  const reloads = { count: 0 };
  return {
    ctx: {
      skill: {
        list: () => Promise.resolve(listFn ? listFn() : { data: editor.skills }),
        transform: (cb: (editor: FakeEditor) => void) => {
          transformed.value = true;
          captured.cb.push(cb);
          cb(editor);
          return Promise.resolve();
        },
        reload: () => {
          reloads.count++;
          for (const cb of captured.cb) cb(editor);
          return Promise.resolve();
        },
      },
    },
    transformed,
    captured,
    reloads,
  };
}

async function runSetup(ctx: {
  skill: {
    list: () => Promise<unknown>;
    transform: (cb: (editor: FakeEditor) => void) => Promise<void>;
    reload: () => Promise<void>;
  };
}): Promise<(() => void) | void> {
  const def = gateModule.default as { setup: (ctx: never) => Promise<(() => void) | void> };
  return def.setup(ctx as never);
}

async function stop(cleanup: (() => void) | void): Promise<void> {
  if (typeof cleanup === "function") cleanup();
}

test("V2 setup hides Explicit-only skills via autoinvoke=false, keeps the rest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autoinvoke-gate-v2-"));
  let cleanup: (() => void) | void = undefined;
  try {
    const hiddenDir = join(dir, "hidden");
    const visibleDir = join(dir, "visible");
    await mkdir(hiddenDir, { recursive: true });
    await mkdir(visibleDir, { recursive: true });
    await writeFile(join(hiddenDir, "SKILL.md"), MARKED_MD);
    await writeFile(join(visibleDir, "SKILL.md"), UNMARKED_MD);
    const editor = makeEditor([
      { id: "hidden-skill", path: join(hiddenDir, "SKILL.md"), content: "body-only" },
      { id: "visible-skill", path: join(visibleDir, "SKILL.md"), content: "body-only" },
      { id: "already-hidden", path: join(visibleDir, "SKILL.md"), content: "body-only", autoinvoke: false },
    ]);
    const ctx2 = fakeCtx(editor);
    cleanup = await runSetup(ctx2.ctx);
    assert.equal(ctx2.transformed.value, true);
    assert.deepEqual(
      editor.updates,
      [{ id: "hidden-skill", autoinvoke: false }],
    );
  } finally {
    await stop(cleanup);
    await rm(dir, { recursive: true, force: true });
  }
});

test("V2 setup classifies from the file on disk, not body-only registry content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autoinvoke-gate-v2-file-"));
  let cleanup: (() => void) | void = undefined;
  try {
    await writeFile(join(dir, "SKILL.md"), MARKED_MD);
    // registry content in V2 is body-only (frontmatter stripped by the native
    // loader): even though it carries no marker, the file on disk does.
    const editor = makeEditor([{ id: "file-marked", path: join(dir, "SKILL.md"), content: "body-only" }]);
    const { ctx } = fakeCtx(editor);
    cleanup = await runSetup(ctx);
    assert.deepEqual(editor.updates, [{ id: "file-marked", autoinvoke: false }]);
  } finally {
    await stop(cleanup);
    await rm(dir, { recursive: true, force: true });
  }
});

test("V2 setup honors the Codex sidecar next to the skill file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autoinvoke-gate-v2-sidecar-"));
  let cleanup: (() => void) | void = undefined;
  try {
    await writeFile(join(dir, "SKILL.md"), UNMARKED_MD);
    await mkdir(join(dir, "agents"), { recursive: true });
    await writeFile(join(dir, "agents", "openai.yaml"), "policy:\n  allow_implicit_invocation: false\n");
    const editor = makeEditor([{ id: "sidecar-skill", path: join(dir, "SKILL.md"), content: "body-only" }]);
    const { ctx } = fakeCtx(editor);
    cleanup = await runSetup(ctx);
    assert.deepEqual(editor.updates, [{ id: "sidecar-skill", autoinvoke: false }]);
  } finally {
    await stop(cleanup);
    await rm(dir, { recursive: true, force: true });
  }
});

test("V2 transform is live: skills added after setup are filtered on reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autoinvoke-gate-v2-live-"));
  let cleanup: (() => void) | void = undefined;
  try {
    const lateDir = join(dir, "late");
    await mkdir(lateDir, { recursive: true });
    await writeFile(join(lateDir, "SKILL.md"), MARKED_MD);
    const editor = makeEditor([]);
    const { ctx, captured } = fakeCtx(editor);
    cleanup = await runSetup(ctx);
    assert.deepEqual(editor.updates, []);
    // skill discovered after setup (registry reload): re-running the
    // registered transform must hide it without another setup call.
    editor.skills.push({ id: "late-skill", path: join(lateDir, "SKILL.md"), content: "body-only" });
    assert.ok(captured.cb[0]);
    (captured.cb[0] as (editor: FakeEditor) => void)(editor);
    assert.deepEqual(editor.updates, [{ id: "late-skill", autoinvoke: false }]);
  } finally {
    await stop(cleanup);
    await rm(dir, { recursive: true, force: true });
  }
});

test("V2 late pass registers after global skills arrive, then reloads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "autoinvoke-gate-v2-late-"));
  let cleanup: (() => void) | void = undefined;
  try {
    await writeFile(join(dir, "SKILL.md"), MARKED_MD);
    // at boot only builtins are listed: nothing to hide yet
    const editor = makeEditor([{ id: "builtin", path: "/builtin/opencode.md", content: "body" }]);
    const { ctx, captured, reloads } = fakeCtx(editor);
    cleanup = await runSetup(ctx);
    assert.equal(captured.cb.length, 1);
    assert.deepEqual(editor.updates, []);
    // discovery: a marked global skill appears
    editor.skills.push({ id: "late-skill", path: join(dir, "SKILL.md"), content: "body-only" });
    const deadline = Date.now() + 5000;
    while (reloads.count === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(reloads.count, 1);
    assert.equal(captured.cb.length, 2);
    assert.deepEqual(editor.updates, [{ id: "late-skill", autoinvoke: false }]);
  } finally {
    await stop(cleanup);
    await rm(dir, { recursive: true, force: true });
  }
});

test("V2 setup is fail-open: missing files stay visible with a warning", async () => {
  const editor = makeEditor([{ id: "missing-skill", path: "/nonexistent/SKILL.md", content: undefined }]);
  const { ctx } = fakeCtx(editor);
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message?: unknown) => {
    warnings.push(String(message));
  };
  let cleanup: (() => void) | void = undefined;
  try {
    cleanup = await runSetup(ctx);
  } finally {
    await stop(cleanup);
    console.warn = originalWarn;
  }
  assert.deepEqual(editor.updates, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] as string, /missing-skill/);
});

test("package exposes the ./server entrypoint for npm plugin resolution", async () => {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const manifest = JSON.parse(raw) as { main?: string; exports?: Record<string, string> };
  assert.equal(manifest.exports?.["."], "./dist/gate.js");
  assert.equal(manifest.exports?.["./server"], "./dist/gate.js");
});

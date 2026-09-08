import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as gateModule from "./gate.ts";
import { createAutoinvokeGateHooks, type GateInput } from "./gate.ts";
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

test("gate keeps a default export pointing at the same function (one filter under legacy loaders)", () => {
  assert.equal(typeof gateModule.createAutoinvokeGateHooks, "function");
  assert.equal(gateModule.default, gateModule.createAutoinvokeGateHooks);
});

test("legacy loader shape (every export invoked, deduped by reference) instantiates exactly once", async () => {
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

test("package exposes the ./server entrypoint for npm plugin resolution", async () => {
  const raw = await readFile(new URL("../package.json", import.meta.url), "utf8");
  const manifest = JSON.parse(raw) as { main?: string; exports?: Record<string, string> };
  assert.equal(manifest.exports?.["."], "./dist/gate.js");
  assert.equal(manifest.exports?.["./server"], "./dist/gate.js");
});

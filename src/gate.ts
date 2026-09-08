import { readFile, realpath } from "node:fs/promises";
import { createCatalogFilter, type SystemOutput } from "./filter.ts";

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

export default createAutoinvokeGateHooks;

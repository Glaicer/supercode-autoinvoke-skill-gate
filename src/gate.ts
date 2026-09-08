import { readFile, realpath } from "node:fs/promises";
import { createCatalogFilter, type SystemOutput } from "./filter.ts";

async function readFileGeneric(filePath: string): Promise<string | undefined> {
  return await readFile(filePath, "utf8");
}

export interface GateHooks {
  "experimental.chat.system.transform": (input: unknown, output: SystemOutput) => Promise<void>;
}

export async function createAutoinvokeGateHooks(): Promise<GateHooks> {
  const filter = createCatalogFilter(readFileGeneric, { realpath });

  return {
    "experimental.chat.system.transform": async (_input: unknown, output: SystemOutput): Promise<void> => {
      await filter(output);
    },
  };
}

export default createAutoinvokeGateHooks;

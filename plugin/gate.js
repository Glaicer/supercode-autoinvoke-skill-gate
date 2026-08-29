import { readFile } from "node:fs/promises"
import { filterSystem } from "../src/filter.js"

async function readSkillFile(location) {
  try {
    return await readFile(location, "utf8")
  } catch {
    return undefined
  }
}

export async function createAutoinvokeGateHooks() {
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      await filterSystem(output, readSkillFile)
    },
  }
}

export default createAutoinvokeGateHooks

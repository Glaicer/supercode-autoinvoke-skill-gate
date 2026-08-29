import { readFile, realpath } from "node:fs/promises"
import { createCatalogFilter } from "../src/filter.js"

async function readFileGeneric(filePath) {
  return await readFile(filePath, "utf8")
}

export async function createAutoinvokeGateHooks() {
  const filter = createCatalogFilter(readFileGeneric, { realpath })

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      await filter(output)
    },
  }
}

export default createAutoinvokeGateHooks

import { BUILTIN_LOCATION, classifyRecord } from "./policy.js"
import path from "node:path"
import { realpath as fsRealpath } from "node:fs/promises"

const HEADER = "<available_skills>"
const FOOTER = "</available_skills>"

function decodeHtml(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
}

function collectBlocks(text, regex) {
  const blocks = []
  let match
  regex.lastIndex = 0
  while ((match = regex.exec(text)) !== null) {
    blocks.push({ text: match[0], index: match.index, end: regex.lastIndex })
  }
  return blocks
}

function rebuildFiltered(text, blocks, shouldKeep) {
  if (blocks.length === 0) return text
  if (blocks.every((block, i) => shouldKeep(block, i))) return text
  let result = ""
  let lastPos = 0
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    const gap = text.slice(lastPos, block.index)
    if (shouldKeep(block, i)) result += gap + block.text
    lastPos = block.end
  }
  result += text.slice(lastPos)
  return result
}

function getSidecarPath(canonicalLocation) {
  return path.join(path.dirname(canonicalLocation), "agents/openai.yaml")
}

async function resolveCanonical(location, realpathFn) {
  if (!realpathFn) return location
  try {
    return await realpathFn(location)
  } catch {
    return location
  }
}

async function evaluateExplicitOnly(location, readFile, realpathFn) {
  if (!location || location === BUILTIN_LOCATION) return { explicitOnly: false, warnings: [] }
  const canonical = await resolveCanonical(location, realpathFn)
  let skillContent
  let skillError
  try {
    const res = await readFile(canonical)
    if (res === undefined) {
      const err = new Error(`missing SKILL.md at ${canonical}`)
      err.code = "ENOENT"
      skillError = err
    } else {
      skillContent = res
    }
  } catch (e) {
    skillError = e
  }

  let sidecarContent
  let sidecarError
  let sidecarMissing = false
  const sidecarPath = getSidecarPath(canonical)
  try {
    const sres = await readFile(sidecarPath)
    if (sres === undefined) sidecarMissing = true
    else sidecarContent = sres
  } catch (e) {
    if (e && (e.code === "ENOENT" || String(e.message).includes("ENOENT"))) sidecarMissing = true
    else sidecarError = e
  }

  const result = classifyRecord({
    skillContent,
    skillReadError: skillError,
    sidecarContent,
    sidecarReadError: sidecarError,
    sidecarMissing,
  })
  return result
}

async function filterSingleCatalogBlockPerCall(catalogBlock, readFile, realpathFn) {
  const start = catalogBlock.indexOf(HEADER)
  const end = catalogBlock.lastIndexOf(FOOTER)
  if (start === -1 || end === -1) return catalogBlock
  const inner = catalogBlock.slice(start + HEADER.length, end)

  const skillRegex = /<skill>[\s\S]*?<\/skill>/g
  const skillBlocks = collectBlocks(inner, skillRegex)
  if (skillBlocks.length === 0) return catalogBlock

  const entries = []
  for (const block of skillBlocks) {
    const locMatch = /<location>([\s\S]*?)<\/location>/.exec(block.text)
    const rawLoc = locMatch ? locMatch[1].trim() : ""
    const loc = decodeHtml(rawLoc)
    let keep = true
    if (loc !== "" && loc !== BUILTIN_LOCATION) {
      try {
        const { explicitOnly } = await evaluateExplicitOnly(loc, readFile, realpathFn)
        keep = !explicitOnly
      } catch {
        keep = true
      }
    }
    entries.push({ ...block, keep })
  }

  if (entries.every((e) => e.keep)) return catalogBlock

  const newInner = rebuildFiltered(
    inner,
    skillBlocks,
    (_block, i) => entries[i].keep,
  )
  return HEADER + newInner + FOOTER
}

function extractDistinctRecords(output) {
  const distinct = new Map()
  if (!output || !Array.isArray(output.system)) return distinct
  const catalogRegex = /<available_skills>[\s\S]*?<\/available_skills>/g
  const skillRegex = /<skill>[\s\S]*?<\/skill>/g
  for (const sys of output.system) {
    if (typeof sys !== "string" || !sys.includes(HEADER)) continue
    const catalogBlocks = collectBlocks(sys, catalogRegex)
    for (const cBlock of catalogBlocks) {
      const start = cBlock.text.indexOf(HEADER)
      const end = cBlock.text.lastIndexOf(FOOTER)
      if (start === -1 || end === -1) continue
      const inner = cBlock.text.slice(start + HEADER.length, end)
      const skillBlocks = collectBlocks(inner, skillRegex)
      for (const sBlock of skillBlocks) {
        const nameMatch = /<name>([\s\S]*?)<\/name>/.exec(sBlock.text)
        const locMatch = /<location>([\s\S]*?)<\/location>/.exec(sBlock.text)
        const rawName = nameMatch ? nameMatch[1].trim() : ""
        const rawLoc = locMatch ? locMatch[1].trim() : ""
        const name = decodeHtml(rawName)
        const loc = decodeHtml(rawLoc)
        const key = `${name}\0${loc}`
        if (!distinct.has(key)) distinct.set(key, { name, location: loc })
      }
    }
  }
  return distinct
}

async function filterSingleCatalogBlockWithSnapshot(catalogBlock, snapshot) {
  const start = catalogBlock.indexOf(HEADER)
  const end = catalogBlock.lastIndexOf(FOOTER)
  if (start === -1 || end === -1) return catalogBlock
  const inner = catalogBlock.slice(start + HEADER.length, end)

  const skillRegex = /<skill>[\s\S]*?<\/skill>/g
  const skillBlocks = collectBlocks(inner, skillRegex)
  if (skillBlocks.length === 0) return catalogBlock

  const keepFlags = []
  for (const block of skillBlocks) {
    const nameMatch = /<name>([\s\S]*?)<\/name>/.exec(block.text)
    const locMatch = /<location>([\s\S]*?)<\/location>/.exec(block.text)
    const rawName = nameMatch ? nameMatch[1].trim() : ""
    const rawLoc = locMatch ? locMatch[1].trim() : ""
    const name = decodeHtml(rawName)
    const loc = decodeHtml(rawLoc)
    const key = `${name}\0${loc}`
    let keep = true
    if (loc === "" || loc === BUILTIN_LOCATION) keep = true
    else if (snapshot.has(key)) keep = !snapshot.get(key)
    else keep = true
    keepFlags.push(keep)
  }

  if (keepFlags.every(Boolean)) return catalogBlock

  const newInner = rebuildFiltered(
    inner,
    skillBlocks,
    (_b, i) => keepFlags[i],
  )
  return HEADER + newInner + FOOTER
}

export async function filterSystem(output, readFile, realpathFn) {
  if (!output || !Array.isArray(output.system)) return
  const catalogRegex = /<available_skills>[\s\S]*?<\/available_skills>/g
  for (let i = 0; i < output.system.length; i++) {
    const sys = output.system[i]
    if (typeof sys !== "string" || !sys.includes(HEADER)) continue
    const catalogBlocks = collectBlocks(sys, catalogRegex)
    if (catalogBlocks.length === 0) continue
    const filteredBlocks = []
    let hasChange = false
    for (const block of catalogBlocks) {
      const filtered = await filterSingleCatalogBlockPerCall(block.text, readFile, realpathFn)
      if (filtered !== block.text) hasChange = true
      filteredBlocks.push(filtered)
    }
    if (!hasChange) continue
    let newSys = ""
    let lastIndex = 0
    for (let j = 0; j < catalogBlocks.length; j++) {
      const block = catalogBlocks[j]
      newSys += sys.slice(lastIndex, block.index) + filteredBlocks[j]
      lastIndex = block.end
    }
    newSys += sys.slice(lastIndex)
    output.system[i] = newSys
  }
}

/**
 * Catalog Policy/Filter seam — single testable surface.
 * Supports both legacy `createCatalogFilter(readSkill)` and snapshot-aware
 * `createCatalogFilter(readFile, { realpath, onWarnings, logger })`.
 * The snapshot is built once at first model request that exposes the catalog
 * and is immutable until the filter instance is recreated (process restart).
 */
export function createCatalogFilter(readFile, options = {}) {
  // normalize overload: if second arg is not an object, treat as no options
  if (options === null || typeof options !== "object" || Array.isArray(options)) options = {}
  // allow passing realpath as function directly for tests: createCatalogFilter(readFile, realpathFn)
  let realpathFn = null
  if (typeof options === "function") {
    realpathFn = options
    options = {}
  } else if (typeof options.realpath === "function") {
    realpathFn = options.realpath
  } else {
    // default: try fs realpath, fallback to identity
    realpathFn = async (p) => {
      try {
        return await fsRealpath(p)
      } catch {
        return p
      }
    }
  }

  let snapshot = null
  let snapshotWarnings = []
  const snapshotWarnSet = new Set()
  let snapshotBuilt = false

  const filterFn = async (output) => {
    if (!output || !Array.isArray(output.system)) return

    const hasCatalog = output.system.some((s) => typeof s === "string" && s.includes(HEADER))

    if (snapshot === null && hasCatalog) {
      const distinct = extractDistinctRecords(output)
      snapshot = new Map()
      for (const [key, rec] of distinct.entries()) {
        if (rec.location === BUILTIN_LOCATION || rec.location === "") {
          snapshot.set(key, false)
          continue
        }
        const { explicitOnly, warnings } = await evaluateExplicitOnly(rec.location, readFile, realpathFn)
        snapshot.set(key, explicitOnly)
        for (const w of warnings) {
          const dedupKey = `${rec.location}::${w}`
          if (!snapshotWarnSet.has(dedupKey)) {
            snapshotWarnSet.add(dedupKey)
            const withLoc = w.includes(rec.location) ? w : `${w} (at ${rec.location})`
            snapshotWarnings.push(withLoc)
          }
        }
      }
      snapshotBuilt = true
      if (snapshotWarnings.length > 0) {
        if (typeof options.onWarnings === "function") {
          try {
            options.onWarnings(snapshotWarnings.slice())
          } catch {}
        } else if (options.logger && typeof options.logger.warn === "function") {
          try {
            options.logger.warn(snapshotWarnings.slice().join("\n"))
          } catch {}
        } else {
          // best-effort log to console, but silent on happy path
          // we warn only via warnings array; headless fallback is log
          // do not throw
        }
      }
    }

    if (snapshot === null) return

    const catalogRegex = /<available_skills>[\s\S]*?<\/available_skills>/g
    for (let i = 0; i < output.system.length; i++) {
      const sys = output.system[i]
      if (typeof sys !== "string" || !sys.includes(HEADER)) continue
      const catalogBlocks = collectBlocks(sys, catalogRegex)
      if (catalogBlocks.length === 0) continue
      const filteredBlocks = []
      let hasChange = false
      for (const block of catalogBlocks) {
        const filtered = await filterSingleCatalogBlockWithSnapshot(block.text, snapshot)
        if (filtered !== block.text) hasChange = true
        filteredBlocks.push(filtered)
      }
      if (!hasChange) continue
      let newSys = ""
      let lastIndex = 0
      for (let j = 0; j < catalogBlocks.length; j++) {
        const block = catalogBlocks[j]
        newSys += sys.slice(lastIndex, block.index) + filteredBlocks[j]
        lastIndex = block.end
      }
      newSys += sys.slice(lastIndex)
      output.system[i] = newSys
    }
  }

  // expose snapshot introspection for tests
  filterFn.getSnapshot = () => snapshot
  filterFn.getWarnings = () => snapshotWarnings.slice()
  filterFn.isSnapshotBuilt = () => snapshotBuilt
  filterFn._resetForTest = () => {
    snapshot = null
    snapshotWarnings = []
    snapshotWarnSet.clear()
    snapshotBuilt = false
  }

  return filterFn
}

// For direct snapshot testing without filter, also export evaluate helper
export { evaluateExplicitOnly, extractDistinctRecords }

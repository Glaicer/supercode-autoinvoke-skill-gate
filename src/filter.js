import { BUILTIN_LOCATION, isExplicitOnly } from "./policy.js"

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

async function filterSingleCatalogBlock(catalogBlock, readSkill) {
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
        const content = await readSkill(loc)
        if (content !== undefined && content !== null) keep = !isExplicitOnly(content)
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

export async function filterSystem(output, readSkill) {
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
      const filtered = await filterSingleCatalogBlock(block.text, readSkill)
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
 * Catalog Policy/Filter seam — single testable surface for ticket 01.
 * Given a `readSkill(location)->markdown` reader, returns a filter that
 * mutates `output.system` in place. Hook adapters (gate.js) and unit tests
 * share this seam; no second metadata scan is performed.
 */
export function createCatalogFilter(readSkill) {
  return async (output) => filterSystem(output, readSkill)
}

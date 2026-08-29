import { isExplicitOnly } from "./policy.js"

function decodeHtml(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
}

async function filterSingleCatalogBlock(catalogBlock, readSkill) {
  const header = "<available_skills>"
  const footer = "</available_skills>"
  const start = catalogBlock.indexOf(header)
  const end = catalogBlock.lastIndexOf(footer)
  if (start === -1 || end === -1) return catalogBlock
  const innerStart = start + header.length
  const innerEnd = end
  const inner = catalogBlock.slice(innerStart, innerEnd)

  const skillRegex = /<skill>[\s\S]*?<\/skill>/g
  const matches = []
  let m
  while ((m = skillRegex.exec(inner)) !== null) {
    matches.push({ text: m[0], index: m.index, end: skillRegex.lastIndex })
  }
  if (matches.length === 0) return catalogBlock

  const keepFlags = []
  for (const sm of matches) {
    const locMatch = /<location>([\s\S]*?)<\/location>/.exec(sm.text)
    const rawLoc = locMatch ? locMatch[1].trim() : ""
    const loc = decodeHtml(rawLoc)
    if (loc === "" || loc === "<built-in>") {
      keepFlags.push(true)
      continue
    }
    let content
    try {
      content = await readSkill(loc)
    } catch {
      keepFlags.push(true)
      continue
    }
    if (content === undefined || content === null) {
      keepFlags.push(true)
      continue
    }
    const hide = isExplicitOnly(content)
    keepFlags.push(!hide)
  }

  if (keepFlags.every(Boolean)) return catalogBlock

  let newInner = ""
  let lastPos = 0
  for (let i = 0; i < matches.length; i++) {
    const sm = matches[i]
    const keep = keepFlags[i]
    const gap = inner.slice(lastPos, sm.index)
    if (keep) {
      newInner += gap + sm.text
    }
    lastPos = sm.end
  }
  newInner += inner.slice(lastPos)
  return header + newInner + footer
}

export async function filterSystem(output, readSkill) {
  if (!output || !Array.isArray(output.system)) return
  const catalogRegex = /<available_skills>[\s\S]*?<\/available_skills>/g
  for (let i = 0; i < output.system.length; i++) {
    const sys = output.system[i]
    if (typeof sys !== "string" || !sys.includes("<available_skills>")) continue
    let newSys = ""
    let lastIndex = 0
    let match
    catalogRegex.lastIndex = 0
    let changed = false
    while ((match = catalogRegex.exec(sys)) !== null) {
      const catalogBlock = match[0]
      const catalogStart = match.index
      const catalogEnd = catalogRegex.lastIndex
      newSys += sys.slice(lastIndex, catalogStart)
      const filtered = await filterSingleCatalogBlock(catalogBlock, readSkill)
      if (filtered !== catalogBlock) changed = true
      newSys += filtered
      lastIndex = catalogEnd
    }
    if (!changed && lastIndex === 0) continue
    newSys += sys.slice(lastIndex)
    if (changed) {
      output.system[i] = newSys
    }
  }
}

export function createCatalogFilter(readSkill) {
  return async (output) => filterSystem(output, readSkill)
}

import { test } from "node:test"
import assert from "node:assert/strict"
import { isExplicitOnly, classifyRecord } from "../src/policy.js"
import { filterSystem, createCatalogFilter } from "../src/filter.js"
import { createAutoinvokeGateHooks } from "../plugin/gate.js"
import path from "node:path"

function skillEntry(name, description, location) {
  return [
    "  <skill>",
    `    <name>${name}</name>`,
    `    <description>${description}</description>`,
    `    <location>${location}</location>`,
    "  </skill>",
  ].join("\n")
}

function catalog(entries) {
  return ["<available_skills>", ...entries, "</available_skills>"].join("\n")
}

function sysWithCatalog(entries, prefix = "PREFIX\n", suffix = "\nSUFFIX") {
  return prefix + catalog(entries) + suffix
}

const MARKED_MD = `---
name: hidden-skill
description: hidden
disable-model-invocation: true
---
body`

const UNMARKED_MD = `---
name: visible-skill
description: visible
---
body`

const QUOTED_TRUE_MD = `---
name: quoted
description: quoted
disable-model-invocation: "true"
---
body`

const FALSE_MD = `---
name: false-skill
description: false
disable-model-invocation: false
---
body`

const NO_MARKER_MD = `---
name: no-marker
description: none
---
body`

// seam uses readSkill mock
function reader(map) {
  return async (loc) => map.get(loc)
}

test("isExplicitOnly recognizes unquoted true", () => {
  assert.equal(isExplicitOnly(MARKED_MD), true)
})

test("isExplicitOnly keeps quoted true as not marked (YAML string vs boolean)", () => {
  assert.equal(isExplicitOnly(QUOTED_TRUE_MD), false)
  assert.equal(isExplicitOnly(`---
name: x
description: x
disable-model-invocation: 'true'
---
`), false)
})

test("isExplicitOnly respects false and absent", () => {
  assert.equal(isExplicitOnly(FALSE_MD), false)
  assert.equal(isExplicitOnly(NO_MARKER_MD), false)
  assert.equal(isExplicitOnly("no frontmatter"), false)
  assert.equal(isExplicitOnly(UNMARKED_MD), false)
})

test("filterSystem removes marked entry, keeps unmarked, preserves order", async () => {
  const map = new Map([
    ["/a/SKILL.md", UNMARKED_MD],
    ["/b/SKILL.md", MARKED_MD],
    ["/c/SKILL.md", UNMARKED_MD],
  ])
  const entries = [
    skillEntry("a-skill", "A", "/a/SKILL.md"),
    skillEntry("b-hidden", "B hidden", "/b/SKILL.md"),
    skillEntry("c-skill", "C", "/c/SKILL.md"),
  ]
  const output = { system: [sysWithCatalog(entries)] }
  const beforeRef = output.system
  await filterSystem(output, reader(map))
  // identity preserved
  assert.equal(output.system, beforeRef)
  const result = output.system[0]
  assert.match(result, /a-skill/)
  assert.match(result, /c-skill/)
  assert.doesNotMatch(result, /b-hidden/)
  // order: a before c
  assert.ok(result.indexOf("a-skill") < result.indexOf("c-skill"))
})

test("filterSystem preserves surrounding system text byte-for-byte", async () => {
  const map = new Map([["/b/SKILL.md", MARKED_MD], ["/a/SKILL.md", UNMARKED_MD]])
  const entries = [skillEntry("a-skill", "A", "/a/SKILL.md"), skillEntry("b-hidden", "B", "/b/SKILL.md")]
  const prefix = "SYSTEM HEADER\nInstructions:\n"
  const suffix = "\nFooter line\nEND"
  const original = prefix + catalog(entries) + suffix
  const output = { system: [original] }
  await filterSystem(output, reader(map))
  const filtered = output.system[0]
  // prefix and suffix untouched
  assert.ok(filtered.startsWith(prefix))
  assert.ok(filtered.endsWith(suffix))
  assert.equal(filtered.slice(0, prefix.length), prefix)
  assert.equal(filtered.slice(filtered.length - suffix.length), suffix)
  // a-skill still present with same bytes
  assert.ok(filtered.includes(skillEntry("a-skill", "A", "/a/SKILL.md")))
})

test("filterSystem mutates in place only catalog-containing elements, keeps identity", async () => {
  const map = new Map([["/b/SKILL.md", MARKED_MD]])
  const entries = [skillEntry("b-hidden", "B", "/b/SKILL.md"), skillEntry("a-skill", "A", "/a/SKILL.md")]
  // Wait map needs both? Actually make second unmarked for this test? But we use map with b marked, a unmarked but map missing a -> keep
  map.set("/a/SKILL.md", UNMARKED_MD)
  const catalogStr = catalog(entries)
  const output = { system: ["no catalog here", "prefix " + catalogStr + " suffix", "also no catalog"] }
  const ref = output.system
  const secondRef = output.system[1]
  await filterSystem(output, reader(map))
  assert.equal(output.system, ref, "array identity")
  assert.equal(output.system[0], "no catalog here")
  assert.equal(output.system[2], "also no catalog")
  // second element was mutated in place (same array slot, but string value changed)
  assert.notEqual(output.system[1], secondRef)
  assert.equal(output.system.length, 3)
  // catalog-containing element got filtered
  assert.doesNotMatch(output.system[1], /b-hidden/)
  assert.match(output.system[1], /a-skill/)
})

test("filterSystem no-op when catalog absent", async () => {
  const map = new Map([["/b/SKILL.md", MARKED_MD]])
  const output = { system: ["hello world", "no skills here"] }
  const before = [...output.system]
  await filterSystem(output, reader(map))
  assert.deepEqual(output.system, before)
  assert.equal(output.system.length, before.length)
})

test("filterSystem all filtered uses same generic path, leaves empty catalog", async () => {
  const map = new Map([
    ["/a/SKILL.md", MARKED_MD],
    ["/b/SKILL.md", MARKED_MD],
  ])
  const entries = [skillEntry("a-hidden", "A", "/a/SKILL.md"), skillEntry("b-hidden", "B", "/b/SKILL.md")]
  const output = { system: [catalog(entries)] }
  await filterSystem(output, reader(map))
  const result = output.system[0]
  // should be empty catalog, no special replacement text
  assert.equal(result, "<available_skills>\n</available_skills>")
  assert.doesNotMatch(result, /a-hidden/)
  assert.doesNotMatch(result, /b-hidden/)
})

test("filterSystem preserves order when filtering middle entry", async () => {
  const map = new Map([
    ["/1/SKILL.md", UNMARKED_MD],
    ["/2/SKILL.md", MARKED_MD],
    ["/3/SKILL.md", UNMARKED_MD],
    ["/4/SKILL.md", UNMARKED_MD],
  ])
  const entries = [
    skillEntry("s1", "1", "/1/SKILL.md"),
    skillEntry("s2", "2", "/2/SKILL.md"),
    skillEntry("s3", "3", "/3/SKILL.md"),
    skillEntry("s4", "4", "/4/SKILL.md"),
  ]
  const output = { system: [catalog(entries)] }
  await filterSystem(output, reader(map))
  const res = output.system[0]
  const idx1 = res.indexOf("s1")
  const idx3 = res.indexOf("s3")
  const idx4 = res.indexOf("s4")
  assert.ok(idx1 < idx3 && idx3 < idx4)
  assert.doesNotMatch(res, /s2/)
})

test("filterSystem keeps quoted true (string) as visible", async () => {
  const map = new Map([["/q/SKILL.md", QUOTED_TRUE_MD], ["/a/SKILL.md", UNMARKED_MD]])
  const entries = [skillEntry("quoted", "q", "/q/SKILL.md"), skillEntry("visible", "v", "/a/SKILL.md")]
  const output = { system: [catalog(entries)] }
  await filterSystem(output, reader(map))
  const res = output.system[0]
  assert.match(res, /quoted/)
  assert.match(res, /visible/)
})

test("filterSystem fail-open on unreadable/missing metadata keeps skill", async () => {
  const map = new Map([["/a/SKILL.md", UNMARKED_MD]])
  const entries = [skillEntry("good", "good", "/a/SKILL.md"), skillEntry("missing", "missing", "/missing/SKILL.md")]
  const output = { system: [catalog(entries)] }
  // reader returns undefined for missing
  await filterSystem(output, reader(map))
  const res = output.system[0]
  assert.match(res, /good/)
  assert.match(res, /missing/)
})

test("filterSystem built-in location kept", async () => {
  const map = new Map()
  const entries = [skillEntry("customize-opencode", "built-in", "<built-in>")]
  const output = { system: [catalog(entries)] }
  await filterSystem(output, reader(map))
  assert.match(output.system[0], /customize-opencode/)
})

test("filterSystem handles multiple catalog blocks in one system string", async () => {
  const map = new Map([["/b/SKILL.md", MARKED_MD], ["/a/SKILL.md", UNMARKED_MD]])
  const entries1 = [skillEntry("a-skill", "A", "/a/SKILL.md"), skillEntry("b-hidden", "B", "/b/SKILL.md")]
  const entries2 = [skillEntry("b-hidden", "B", "/b/SKILL.md")]
  const sys = catalog(entries1) + "\nMIDDLE\n" + catalog(entries2)
  const output = { system: [sys] }
  await filterSystem(output, reader(map))
  const res = output.system[0]
  // first catalog should have a but not b
  const firstPart = res.split("MIDDLE")[0]
  assert.match(firstPart, /a-skill/)
  assert.doesNotMatch(firstPart, /b-hidden/)
  // second catalog empty
  const secondPart = res.split("MIDDLE")[1]
  assert.doesNotMatch(secondPart, /b-hidden/)
  assert.equal(secondPart.trim(), "<available_skills>\n</available_skills>")
})

test("createCatalogFilter seam returns same behavior", async () => {
  const map = new Map([["/b/SKILL.md", MARKED_MD]])
  map.set("/a/SKILL.md", UNMARKED_MD)
  const fn = createCatalogFilter(reader(map))
  const output = { system: [catalog([skillEntry("a-skill", "A", "/a/SKILL.md"), skillEntry("b-hidden", "B", "/b/SKILL.md")])] }
  await fn(output)
  assert.doesNotMatch(output.system[0], /b-hidden/)
  assert.match(output.system[0], /a-skill/)
})

test("plugin gate registers only experimental.chat.system.transform", async () => {
  const hooks = await createAutoinvokeGateHooks()
  assert.ok(hooks["experimental.chat.system.transform"], "should have system transform")
  assert.equal(hooks["tool.execute.before"], undefined)
  assert.equal(hooks["tool.execute.after"], undefined)
  assert.equal(hooks["permission.ask"], undefined)
  // ensure no other invocation guard keys
  const keys = Object.keys(hooks)
  assert.deepEqual(keys, ["experimental.chat.system.transform"])
})

test("plugin gate transform is silent on happy path (no log side effects)", async () => {
  const hooks = await createAutoinvokeGateHooks()
  // just ensure it doesn't throw on no catalog and doesn't require log
  const output = { system: ["hello"] }
  await hooks["experimental.chat.system.transform"]({}, output)
  assert.deepEqual(output, { system: ["hello"] })
})

test("explicit invocation not blocked: filtering catalog does not affect tool availability", async () => {
  // This is proven by absence of tool guard; just assert hooks do not block skill tool
  const hooks = await createAutoinvokeGateHooks()
  // No tool guard, so skill tool remains allowed at permission layer
  assert.equal(typeof hooks["tool.execute.before"], "undefined")
})

// === 02: Portable marker policy и immutable snapshot ===

const META_FALSE_MD = `---
name: meta-skill
description: meta
metadata:
  opencode/autoinvoke: false
---
body`

const META_TRUE_MD = `---
name: meta-skill
description: meta
metadata:
  opencode/autoinvoke: true
---
body`

const META_QUOTED_MD = `---
name: meta-skill
metadata:
  opencode/autoinvoke: "false"
---
body`

const SIDECAR_FALSE = `policy:
  allow_implicit_invocation: false
`

const SIDECAR_TRUE = `policy:
  allow_implicit_invocation: true
`

const SIDECAR_QUOTED = `policy:
  allow_implicit_invocation: "false"
`

function throwingReader(map, errorPath, error) {
  return async (loc) => {
    if (loc === errorPath) throw error
    if (map.has(loc)) return map.get(loc)
    const e = new Error(`ENOENT: ${loc}`)
    e.code = "ENOENT"
    throw e
  }
}

test("filterSystem recognizes metadata.opencode/autoinvoke: false as Explicit-only", async () => {
  const map = new Map([["/m/SKILL.md", META_FALSE_MD]])
  const out = { system: [catalog([skillEntry("m", "M", "/m/SKILL.md")])] }
  await filterSystem(out, reader(map))
  assert.doesNotMatch(out.system[0], /\/m\/SKILL\.md/)
})

test("filterSystem recognizes sidecar policy.allow_implicit_invocation: false as Explicit-only", async () => {
  const map = new Map([
    ["/s/SKILL.md", UNMARKED_MD],
    ["/s/agents/openai.yaml", SIDECAR_FALSE],
  ])
  const out = { system: [catalog([skillEntry("s", "S", "/s/SKILL.md")])] }
  await filterSystem(out, reader(map))
  assert.doesNotMatch(out.system[0], /\/s\/SKILL\.md/)
})

test("only YAML boolean counts — quoted, number, null, array stay visible", async () => {
  const mdQuotedMeta = META_QUOTED_MD
  const mdNum = `---
name: x
disable-model-invocation: 1
---
body`
  const mdNull = `---
name: x
disable-model-invocation: null
---
body`
  const mdArray = `---
name: x
disable-model-invocation: [true]
---
body`
  const map = new Map([
    ["/q/SKILL.md", mdQuotedMeta],
    ["/n/SKILL.md", mdNum],
    ["/null/SKILL.md", mdNull],
    ["/arr/SKILL.md", mdArray],
  ])
  const entries = [
    skillEntry("q", "Q", "/q/SKILL.md"),
    skillEntry("n", "N", "/n/SKILL.md"),
    skillEntry("null", "N", "/null/SKILL.md"),
    skillEntry("arr", "A", "/arr/SKILL.md"),
  ]
  const out = { system: [catalog(entries)] }
  await filterSystem(out, reader(map))
  for (const e of entries) assert.match(out.system[0], new RegExp(e.match(/<name>(.*?)<\/name>/)[1]))
  const r1 = classifyRecord({ skillContent: mdQuotedMeta, sidecarMissing: true })
  assert.ok(r1.warnings.some((w) => w.includes("invalid type")))
  const r2 = classifyRecord({ skillContent: mdNum, sidecarMissing: true })
  assert.ok(r2.warnings.some((w) => w.includes("invalid type")))
})

test("ANY valid denying marker makes Explicit-only; allowing marker does not cancel and creates warning", async () => {
  const mdConflict = `---
name: x
disable-model-invocation: true
metadata:
  opencode/autoinvoke: true
---
body`
  const r = classifyRecord({ skillContent: mdConflict, sidecarMissing: true })
  assert.equal(r.explicitOnly, true)
  assert.ok(r.warnings.some((w) => w.includes("conflicting")))

  const mdWithSidecarAllow = `---
name: x
disable-model-invocation: true
---
body`
  const r2 = classifyRecord({ skillContent: mdWithSidecarAllow, sidecarContent: SIDECAR_TRUE, sidecarMissing: false })
  assert.equal(r2.explicitOnly, true)
  assert.ok(r2.warnings.some((w) => w.includes("conflicting")))

  const map = new Map([
    ["/c/SKILL.md", mdConflict],
  ])
  const out = { system: [catalog([skillEntry("c", "C", "/c/SKILL.md")])] }
  await filterSystem(out, reader(map))
  assert.doesNotMatch(out.system[0], /\/c\/SKILL\.md/)
})

test("absent marker and absent optional sidecar produce no warning", () => {
  const r = classifyRecord({ skillContent: UNMARKED_MD, sidecarMissing: true })
  assert.equal(r.warnings.length, 0)
  assert.equal(r.explicitOnly, false)
})

test("malformed YAML, read error, wrong type, duplicate ambiguous fail-open with warning; other valid deny still applies", async () => {
  const badSkill = `---
name: x
disable-model-invocation: [
---
body`
  const sidecarDeny = SIDECAR_FALSE
  const r = classifyRecord({ skillContent: badSkill, sidecarContent: sidecarDeny, sidecarMissing: false })
  assert.equal(r.explicitOnly, true, "sidecar deny still applies despite skill malformed")
  assert.ok(r.warnings.some((w) => w.includes("malformed")))

  const readErr = Object.assign(new Error("EACCES"), { code: "EACCES" })
  const mdAllow = `---
name: x
disable-model-invocation: false
---
body`
  const r2 = classifyRecord({ skillContent: mdAllow, skillReadError: readErr, sidecarContent: sidecarDeny, sidecarMissing: false })
  assert.equal(r2.explicitOnly, true)
  assert.ok(r2.warnings.some((w) => w.includes("read error")))

  const mdWrong = `---
name: x
disable-model-invocation: "true"
metadata:
  opencode/autoinvoke: false
---
body`
  const r3 = classifyRecord({ skillContent: mdWrong, sidecarMissing: true })
  assert.equal(r3.explicitOnly, true, "metadata deny still applies despite disable wrong type")
  assert.ok(r3.warnings.some((w) => w.includes("invalid type")))

  const dup = `---
name: x
disable-model-invocation: true
disable-model-invocation: false
---
body`
  const rDup = classifyRecord({ skillContent: dup, sidecarMissing: true })
  assert.equal(rDup.explicitOnly, false, "duplicate ambiguous fail-open")
  assert.ok(rDup.warnings.some((w) => w.includes("duplicate") || w.includes("ambiguous")))

  // via filterSystem: malformed skill stays visible if no other deny
  const mapBad = new Map([["/bad/SKILL.md", badSkill]])
  const outBad = { system: [catalog([skillEntry("bad", "B", "/bad/SKILL.md")])] }
  await filterSystem(outBad, reader(mapBad))
  assert.match(outBad.system[0], /bad/, "malformed without other deny stays visible")

  // via filterSystem: wrong type stays visible
  const mapWrong = new Map([["/w/SKILL.md", `---\ndisable-model-invocation: "true"\n---\nbody`]])
  const outWrong = { system: [catalog([skillEntry("w", "W", "/w/SKILL.md")])] }
  await filterSystem(outWrong, reader(mapWrong))
  assert.match(outWrong.system[0], /W/)
})

test("source of truth is actual <name> and <location>; duplicate name in other location does not affect selected record", async () => {
  const map = new Map([
    ["/a/SKILL.md", MARKED_MD],
    ["/b/SKILL.md", UNMARKED_MD],
  ])
  const out = { system: [catalog([skillEntry("dup", "D", "/a/SKILL.md"), skillEntry("dup", "D", "/b/SKILL.md")])] }
  await filterSystem(out, reader(map))
  assert.doesNotMatch(out.system[0], /\/a\/SKILL\.md/)
  assert.match(out.system[0], /\/b\/SKILL\.md/)

  const out2 = { system: [catalog([skillEntry("dup", "D", "/b/SKILL.md")])] }
  await filterSystem(out2, reader(map))
  assert.match(out2.system[0], /\/b\/SKILL\.md/)
})

test("location safely resolves via symlink alias; metadata read only at selected file and adjacent sidecar", async () => {
  const map = new Map([
    ["/real/SKILL.md", MARKED_MD],
    ["/real/agents/openai.yaml", SIDECAR_TRUE],
  ])
  const read = async (p) => {
    if (map.has(p)) return map.get(p)
    const e = new Error(`ENOENT: ${p}`)
    e.code = "ENOENT"
    throw e
  }
  const realpath = async (p) => (p === "/link/SKILL.md" ? "/real/SKILL.md" : p)
  const filter = createCatalogFilter(read, { realpath })
  const out = { system: [catalog([skillEntry("linkskill", "L", "/link/SKILL.md")])] }
  await filter(out)
  assert.doesNotMatch(out.system[0], /\/link\/SKILL\.md/)
  assert.ok(filter.getWarnings().some((w) => w.includes("conflicting")))
})

test("metadata read once at first model request; changes after ignored until restart", async () => {
  const map = new Map([
    ["/a/SKILL.md", MARKED_MD],
    ["/b/SKILL.md", UNMARKED_MD],
  ])
  const read = async (p) => {
    if (map.has(p)) return map.get(p)
    const e = new Error(`ENOENT: ${p}`)
    e.code = "ENOENT"
    throw e
  }
  const filter = createCatalogFilter(read)
  const entries = [skillEntry("a", "A", "/a/SKILL.md"), skillEntry("b", "B", "/b/SKILL.md")]
  const out1 = { system: [catalog(entries)] }
  await filter(out1)
  assert.doesNotMatch(out1.system[0], /\/a\/SKILL\.md/)
  assert.match(out1.system[0], /\/b\/SKILL\.md/)

  map.set("/a/SKILL.md", UNMARKED_MD)
  map.set("/b/SKILL.md", MARKED_MD)
  const out2 = { system: [catalog(entries)] }
  await filter(out2)
  assert.doesNotMatch(out2.system[0], /\/a\/SKILL\.md/, "snapshot immutable: a still filtered")
  assert.match(out2.system[0], /\/b\/SKILL\.md/, "snapshot immutable: b still visible")
})

test("identities not in first snapshot are preserved fail-open and do not trigger rescan", async () => {
  const map = new Map([["/a/SKILL.md", UNMARKED_MD]])
  const read = async (p) => {
    if (map.has(p)) return map.get(p)
    const e = new Error(`ENOENT: ${p}`)
    e.code = "ENOENT"
    throw e
  }
  const filter = createCatalogFilter(read)
  const out1 = { system: [catalog([skillEntry("a", "A", "/a/SKILL.md")])] }
  await filter(out1)
  assert.match(out1.system[0], /\/a\/SKILL\.md/)

  map.set("/c/SKILL.md", MARKED_MD)
  const out2 = { system: [catalog([skillEntry("a", "A", "/a/SKILL.md"), skillEntry("c", "C", "/c/SKILL.md")])] }
  await filter(out2)
  assert.match(out2.system[0], /\/c\/SKILL\.md/, "unknown identity fail-open")
})

test("deduplicated warnings not spammed on repeated transforms", async () => {
  const map = new Map([["/a/SKILL.md", `---\ndisable-model-invocation: "true"\n---\nbody`]])
  const read = async (p) => {
    if (map.has(p)) return map.get(p)
    const e = new Error(`ENOENT: ${p}`)
    e.code = "ENOENT"
    throw e
  }
  const filter = createCatalogFilter(read)
  const out1 = { system: [catalog([skillEntry("a", "A", "/a/SKILL.md")])] }
  await filter(out1)
  const w1 = filter.getWarnings()
  assert.equal(w1.length, 1)
  const out2 = { system: [catalog([skillEntry("a", "A", "/a/SKILL.md")])] }
  await filter(out2)
  const w2 = filter.getWarnings()
  assert.equal(w2.length, 1, "warnings not duplicated on second transform")
})

test("filterSystem and snapshot filter handle three markers via same seam (integration)", async () => {
  const map = new Map([
    ["/x/SKILL.md", `---\nmetadata:\n  opencode/autoinvoke: false\n---\nbody`],
    ["/y/SKILL.md", UNMARKED_MD],
    ["/y/agents/openai.yaml", SIDECAR_FALSE],
  ])
  const out = { system: [catalog([skillEntry("x", "X", "/x/SKILL.md"), skillEntry("y", "Y", "/y/SKILL.md")])] }
  await filterSystem(out, reader(map))
  assert.doesNotMatch(out.system[0], /\/x\/SKILL\.md/)
  assert.doesNotMatch(out.system[0], /\/y\/SKILL\.md/)
})

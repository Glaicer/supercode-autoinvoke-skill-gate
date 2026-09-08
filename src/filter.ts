import { BUILTIN_LOCATION, classifyRecord } from "./policy.ts";
import path from "node:path";
import { realpath as fsRealpath } from "node:fs/promises";

const HEADER = "<available_skills>";
const FOOTER = "</available_skills>";

export type ReadFile = (filePath: string) => Promise<string | undefined>;
export type RealpathFn = (filePath: string) => Promise<string>;

export interface SystemOutput {
  system?: unknown;
}

export interface CatalogRecord {
  name: string;
  location: string;
}

export interface CatalogLogger {
  warn: (message: string) => void;
}

export interface CatalogFilterOptions {
  realpath?: RealpathFn;
  onWarnings?: (warnings: string[]) => void;
  logger?: CatalogLogger;
}

export type CatalogFilterOptionsInput = CatalogFilterOptions | RealpathFn | null | undefined;

interface Block {
  text: string;
  index: number;
  end: number;
}

interface SkillEntry extends Block {
  keep: boolean;
}

export interface CatalogFilter {
  (output: SystemOutput): Promise<void>;
  getSnapshot: () => Map<string, boolean> | null;
  getWarnings: () => string[];
  isSnapshotBuilt: () => boolean;
  _resetForTest: () => void;
}

function decodeHtml(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function collectBlocks(text: string, regex: RegExp): Block[] {
  const blocks: Block[] = [];
  let match: RegExpExecArray | null;
  regex.lastIndex = 0;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({ text: match[0] ?? "", index: match.index, end: regex.lastIndex });
  }
  return blocks;
}

function rebuildFiltered(text: string, blocks: Block[], shouldKeep: (block: Block, i: number) => boolean): string {
  if (blocks.length === 0) return text;
  if (blocks.every((block, i) => shouldKeep(block, i))) return text;
  let result = "";
  let lastPos = 0;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i] as Block;
    const gap = text.slice(lastPos, block.index);
    if (shouldKeep(block, i)) result += gap + block.text;
    lastPos = block.end;
  }
  result += text.slice(lastPos);
  return result;
}

function getSidecarPath(canonicalLocation: string): string {
  return path.join(path.dirname(canonicalLocation), "agents/openai.yaml");
}

async function resolveCanonical(location: string, realpathFn: RealpathFn | null): Promise<string> {
  if (!realpathFn) return location;
  try {
    return await realpathFn(location);
  } catch {
    return location;
  }
}

async function evaluateExplicitOnly(
  location: string,
  readFile: ReadFile,
  realpathFn: RealpathFn | null,
): Promise<{ explicitOnly: boolean; warnings: string[] }> {
  if (!location || location === BUILTIN_LOCATION) return { explicitOnly: false, warnings: [] };
  const canonical = await resolveCanonical(location, realpathFn);
  let skillContent: string | undefined;
  let skillError: unknown;
  try {
    const res = await readFile(canonical);
    if (res === undefined) {
      const err = new Error(`missing SKILL.md at ${canonical}`) as Error & { code?: string };
      err.code = "ENOENT";
      skillError = err;
    } else {
      skillContent = res;
    }
  } catch (e) {
    skillError = e;
  }

  let sidecarContent: string | undefined;
  let sidecarError: unknown;
  let sidecarMissing = false;
  const sidecarPath = getSidecarPath(canonical);
  try {
    const sres = await readFile(sidecarPath);
    if (sres === undefined) sidecarMissing = true;
    else sidecarContent = sres;
  } catch (e) {
    if (e && (errorCodeOf(e).code === "ENOENT" || String(errorMessage(e)).includes("ENOENT"))) sidecarMissing = true;
    else sidecarError = e;
  }

  const result = classifyRecord({
    skillContent,
    skillReadError: skillError,
    sidecarContent,
    sidecarReadError: sidecarError,
    sidecarMissing,
  });
  return result;
}

function errorCodeOf(e: unknown): { code?: unknown } {
  if (e && typeof e === "object" && "code" in e) return e as { code?: unknown };
  return {};
}

function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}

async function filterSingleCatalogBlockPerCall(
  catalogBlock: string,
  readFile: ReadFile,
  realpathFn: RealpathFn | null,
): Promise<string> {
  const start = catalogBlock.indexOf(HEADER);
  const end = catalogBlock.lastIndexOf(FOOTER);
  if (start === -1 || end === -1) return catalogBlock;
  const inner = catalogBlock.slice(start + HEADER.length, end);

  const skillRegex = /<skill>[\s\S]*?<\/skill>/g;
  const skillBlocks = collectBlocks(inner, skillRegex);
  if (skillBlocks.length === 0) return catalogBlock;

  const entries: SkillEntry[] = [];
  for (const block of skillBlocks) {
    const locMatch = /<location>([\s\S]*?)<\/location>/.exec(block.text);
    const rawLoc = locMatch?.[1]?.trim() ?? "";
    const loc = decodeHtml(rawLoc);
    let keep = true;
    if (loc !== "" && loc !== BUILTIN_LOCATION) {
      try {
        const { explicitOnly } = await evaluateExplicitOnly(loc, readFile, realpathFn);
        keep = !explicitOnly;
      } catch {
        keep = true;
      }
    }
    entries.push({ ...block, keep });
  }

  if (entries.every((e) => e.keep)) return catalogBlock;

  const newInner = rebuildFiltered(inner, skillBlocks, (_block, i) => entries[i]?.keep ?? true);
  return HEADER + newInner + FOOTER;
}

function extractDistinctRecords(output: SystemOutput): Map<string, CatalogRecord> {
  const distinct = new Map<string, CatalogRecord>();
  if (!output || !Array.isArray(output.system)) return distinct;
  const catalogRegex = /<available_skills>[\s\S]*?<\/available_skills>/g;
  const skillRegex = /<skill>[\s\S]*?<\/skill>/g;
  for (const sys of output.system as unknown[]) {
    if (typeof sys !== "string" || !sys.includes(HEADER)) continue;
    const catalogBlocks = collectBlocks(sys, catalogRegex);
    for (const cBlock of catalogBlocks) {
      const start = cBlock.text.indexOf(HEADER);
      const end = cBlock.text.lastIndexOf(FOOTER);
      if (start === -1 || end === -1) continue;
      const inner = cBlock.text.slice(start + HEADER.length, end);
      const skillBlocks = collectBlocks(inner, skillRegex);
      for (const sBlock of skillBlocks) {
        const nameMatch = /<name>([\s\S]*?)<\/name>/.exec(sBlock.text);
        const locMatch = /<location>([\s\S]*?)<\/location>/.exec(sBlock.text);
        const rawName = nameMatch?.[1]?.trim() ?? "";
        const rawLoc = locMatch?.[1]?.trim() ?? "";
        const name = decodeHtml(rawName);
        const loc = decodeHtml(rawLoc);
        const key = `${name}\0${loc}`;
        if (!distinct.has(key)) distinct.set(key, { name, location: loc });
      }
    }
  }
  return distinct;
}

async function filterSingleCatalogBlockWithSnapshot(
  catalogBlock: string,
  snapshot: Map<string, boolean>,
): Promise<string> {
  const start = catalogBlock.indexOf(HEADER);
  const end = catalogBlock.lastIndexOf(FOOTER);
  if (start === -1 || end === -1) return catalogBlock;
  const inner = catalogBlock.slice(start + HEADER.length, end);

  const skillRegex = /<skill>[\s\S]*?<\/skill>/g;
  const skillBlocks = collectBlocks(inner, skillRegex);
  if (skillBlocks.length === 0) return catalogBlock;

  const keepFlags: boolean[] = [];
  for (const block of skillBlocks) {
    const nameMatch = /<name>([\s\S]*?)<\/name>/.exec(block.text);
    const locMatch = /<location>([\s\S]*?)<\/location>/.exec(block.text);
    const rawName = nameMatch?.[1]?.trim() ?? "";
    const rawLoc = locMatch?.[1]?.trim() ?? "";
    const name = decodeHtml(rawName);
    const loc = decodeHtml(rawLoc);
    const key = `${name}\0${loc}`;
    let keep = true;
    if (loc === "" || loc === BUILTIN_LOCATION) keep = true;
    else if (snapshot.has(key)) keep = !snapshot.get(key);
    else keep = true;
    keepFlags.push(keep);
  }

  if (keepFlags.every(Boolean)) return catalogBlock;

  const newInner = rebuildFiltered(inner, skillBlocks, (_b, i) => keepFlags[i] ?? true);
  return HEADER + newInner + FOOTER;
}

export async function filterSystem(
  output: SystemOutput,
  readFile: ReadFile,
  realpathFn: RealpathFn | null = null,
): Promise<void> {
  if (!output || !Array.isArray(output.system)) return;
  const catalogRegex = /<available_skills>[\s\S]*?<\/available_skills>/g;
  const system = output.system as unknown[];
  for (let i = 0; i < system.length; i++) {
    const sys = system[i];
    if (typeof sys !== "string" || !sys.includes(HEADER)) continue;
    const catalogBlocks = collectBlocks(sys, catalogRegex);
    if (catalogBlocks.length === 0) continue;
    const filteredBlocks: string[] = [];
    let hasChange = false;
    for (const block of catalogBlocks) {
      const filtered = await filterSingleCatalogBlockPerCall(block.text, readFile, realpathFn);
      if (filtered !== block.text) hasChange = true;
      filteredBlocks.push(filtered);
    }
    if (!hasChange) continue;
    let newSys = "";
    let lastIndex = 0;
    for (let j = 0; j < catalogBlocks.length; j++) {
      const block = catalogBlocks[j] as Block;
      newSys += sys.slice(lastIndex, block.index) + (filteredBlocks[j] ?? "");
      lastIndex = block.end;
    }
    newSys += sys.slice(lastIndex);
    system[i] = newSys;
  }
}

/**
 * Catalog Policy/Filter seam — single testable surface.
 * Supports both legacy `createCatalogFilter(readSkill)` and snapshot-aware
 * `createCatalogFilter(readFile, { realpath, onWarnings, logger })`.
 * The snapshot is built once at first model request that exposes the catalog
 * and is immutable until the filter instance is recreated (process restart).
 */
export function createCatalogFilter(readFile: ReadFile, options: CatalogFilterOptionsInput = {}): CatalogFilter {
  // allow passing realpath as function directly for tests: createCatalogFilter(readFile, realpathFn)
  let realpathFn: RealpathFn | null = null;
  let opts: CatalogFilterOptions = {};
  if (typeof options === "function") {
    realpathFn = options;
  } else if (options === null || typeof options !== "object" || Array.isArray(options)) {
    opts = {};
  } else {
    opts = options;
    if (typeof opts.realpath === "function") {
      realpathFn = opts.realpath;
    }
  }
  if (realpathFn === null) {
    // default: try fs realpath, fallback to identity
    realpathFn = async (p: string): Promise<string> => {
      try {
        return await fsRealpath(p);
      } catch {
        return p;
      }
    };
  }
  const resolvedRealpath: RealpathFn = realpathFn;

  let snapshot: Map<string, boolean> | null = null;
  let snapshotWarnings: string[] = [];
  const snapshotWarnSet = new Set<string>();
  let snapshotBuilt = false;

  const filterFn = (async (output: SystemOutput): Promise<void> => {
    if (!output || !Array.isArray(output.system)) return;

    const system = output.system as unknown[];
    const hasCatalog = system.some((s) => typeof s === "string" && (s as string).includes(HEADER));

    if (snapshot === null && hasCatalog) {
      const distinct = extractDistinctRecords(output);
      snapshot = new Map<string, boolean>();
      for (const [key, rec] of distinct.entries()) {
        if (rec.location === BUILTIN_LOCATION || rec.location === "") {
          snapshot.set(key, false);
          continue;
        }
        const { explicitOnly, warnings } = await evaluateExplicitOnly(rec.location, readFile, resolvedRealpath);
        snapshot.set(key, explicitOnly);
        for (const w of warnings) {
          const dedupKey = `${rec.location}::${w}`;
          if (!snapshotWarnSet.has(dedupKey)) {
            snapshotWarnSet.add(dedupKey);
            const withLoc = w.includes(rec.location) ? w : `${w} (at ${rec.location})`;
            snapshotWarnings.push(withLoc);
          }
        }
      }
      snapshotBuilt = true;
      if (snapshotWarnings.length > 0) {
        if (typeof opts.onWarnings === "function") {
          try {
            opts.onWarnings(snapshotWarnings.slice());
          } catch {}
        } else if (opts.logger && typeof opts.logger.warn === "function") {
          try {
            opts.logger.warn(snapshotWarnings.slice().join("\n"));
          } catch {}
        } else {
          // best-effort log to console, but silent on happy path
          // we warn only via warnings array; headless fallback is log
          // do not throw
        }
      }
    }

    if (snapshot === null) return;

    const catalogRegex = /<available_skills>[\s\S]*?<\/available_skills>/g;
    for (let i = 0; i < system.length; i++) {
      const sys = system[i];
      if (typeof sys !== "string" || !sys.includes(HEADER)) continue;
      const catalogBlocks = collectBlocks(sys, catalogRegex);
      if (catalogBlocks.length === 0) continue;
      const filteredBlocks: string[] = [];
      let hasChange = false;
      for (const block of catalogBlocks) {
        const filtered = await filterSingleCatalogBlockWithSnapshot(block.text, snapshot);
        if (filtered !== block.text) hasChange = true;
        filteredBlocks.push(filtered);
      }
      if (!hasChange) continue;
      let newSys = "";
      let lastIndex = 0;
      for (let j = 0; j < catalogBlocks.length; j++) {
        const block = catalogBlocks[j] as Block;
        newSys += sys.slice(lastIndex, block.index) + (filteredBlocks[j] ?? "");
        lastIndex = block.end;
      }
      newSys += sys.slice(lastIndex);
      system[i] = newSys;
    }
  }) as CatalogFilter;

  // expose snapshot introspection for tests
  filterFn.getSnapshot = () => snapshot;
  filterFn.getWarnings = () => snapshotWarnings.slice();
  filterFn.isSnapshotBuilt = () => snapshotBuilt;
  filterFn._resetForTest = () => {
    snapshot = null;
    snapshotWarnings = [];
    snapshotWarnSet.clear();
    snapshotBuilt = false;
  };

  return filterFn;
}

// For direct snapshot testing without filter, also export evaluate helper
export { evaluateExplicitOnly, extractDistinctRecords };

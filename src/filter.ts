import { BUILTIN_LOCATION, classifyRecord, errorMessage } from "./policy.ts";
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

/** Identity selected by OpenCode for a `<skill>` record: the source of truth for policy. */
function parseSkillIdentity(blockText: string): CatalogRecord {
  const nameMatch = /<name>([\s\S]*?)<\/name>/.exec(blockText);
  const locMatch = /<location>([\s\S]*?)<\/location>/.exec(blockText);
  return {
    name: decodeHtml(nameMatch?.[1]?.trim() ?? ""),
    location: decodeHtml(locMatch?.[1]?.trim() ?? ""),
  };
}

/** Inner text between the catalog HEADER/FOOTER, or null when the block has no catalog frame. */
function getCatalogInner(catalogBlock: string): string | null {
  const start = catalogBlock.indexOf(HEADER);
  const end = catalogBlock.lastIndexOf(FOOTER);
  if (start === -1 || end === -1) return null;
  return catalogBlock.slice(start + HEADER.length, end);
}

/**
 * Shared catalog-block surgery: collect `<skill>` records, ask `decideKeep`
 * per record identity, and rebuild the block without dropped records.
 * Returns the input unchanged when every record is kept.
 */
async function rebuildCatalogBlock(
  catalogBlock: string,
  decideKeep: (record: CatalogRecord, index: number) => boolean | Promise<boolean>,
): Promise<string> {
  const inner = getCatalogInner(catalogBlock);
  if (inner === null) return catalogBlock;
  const skillRegex = /<skill>[\s\S]*?<\/skill>/g;
  const skillBlocks = collectBlocks(inner, skillRegex);
  if (skillBlocks.length === 0) return catalogBlock;
  const keepFlags: boolean[] = [];
  for (let i = 0; i < skillBlocks.length; i++) {
    keepFlags.push(await decideKeep(parseSkillIdentity((skillBlocks[i] as Block).text), i));
  }
  if (keepFlags.every(Boolean)) return catalogBlock;
  return HEADER + rebuildFiltered(inner, skillBlocks, (_block, i) => keepFlags[i] ?? true) + FOOTER;
}

/**
 * Shared system-text surgery: map every `<available_skills>` block through
 * `mapBlock` and splice the results back byte-for-byte around them.
 */
async function rewriteSystemText(
  sys: string,
  mapBlock: (blockText: string) => Promise<string>,
): Promise<{ text: string; changed: boolean }> {
  const catalogRegex = /<available_skills>[\s\S]*?<\/available_skills>/g;
  const catalogBlocks = collectBlocks(sys, catalogRegex);
  if (catalogBlocks.length === 0) return { text: sys, changed: false };
  const filteredBlocks: string[] = [];
  let hasChange = false;
  for (const block of catalogBlocks) {
    const filtered = await mapBlock(block.text);
    if (filtered !== block.text) hasChange = true;
    filteredBlocks.push(filtered);
  }
  if (!hasChange) return { text: sys, changed: false };
  let newSys = "";
  let lastIndex = 0;
  for (let j = 0; j < catalogBlocks.length; j++) {
    const block = catalogBlocks[j] as Block;
    newSys += sys.slice(lastIndex, block.index) + (filteredBlocks[j] ?? "");
    lastIndex = block.end;
  }
  newSys += sys.slice(lastIndex);
  return { text: newSys, changed: true };
}

async function filterSingleCatalogBlockPerCall(
  catalogBlock: string,
  readFile: ReadFile,
  realpathFn: RealpathFn | null,
): Promise<string> {
  return rebuildCatalogBlock(catalogBlock, async ({ location }) => {
    if (location === "" || location === BUILTIN_LOCATION) return true;
    try {
      const { explicitOnly } = await evaluateExplicitOnly(location, readFile, realpathFn);
      return !explicitOnly;
    } catch {
      return true;
    }
  });
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
      const inner = getCatalogInner(cBlock.text);
      if (inner === null) continue;
      const skillBlocks = collectBlocks(inner, skillRegex);
      for (const sBlock of skillBlocks) {
        const { name, location } = parseSkillIdentity(sBlock.text);
        const key = `${name}\0${location}`;
        if (!distinct.has(key)) distinct.set(key, { name, location });
      }
    }
  }
  return distinct;
}

async function filterSingleCatalogBlockWithSnapshot(
  catalogBlock: string,
  snapshot: Map<string, boolean>,
): Promise<string> {
  return rebuildCatalogBlock(catalogBlock, ({ name, location }) => {
    if (location === "" || location === BUILTIN_LOCATION) return true;
    const key = `${name}\0${location}`;
    if (snapshot.has(key)) return !snapshot.get(key);
    return true;
  });
}

export async function filterSystem(
  output: SystemOutput,
  readFile: ReadFile,
  realpathFn: RealpathFn | null = null,
): Promise<void> {
  if (!output || !Array.isArray(output.system)) return;
  const system = output.system as unknown[];
  for (let i = 0; i < system.length; i++) {
    const sys = system[i];
    if (typeof sys !== "string" || !sys.includes(HEADER)) continue;
    const { text, changed } = await rewriteSystemText(sys, (block) =>
      filterSingleCatalogBlockPerCall(block, readFile, realpathFn),
    );
    if (changed) system[i] = text;
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

    const snap = snapshot;
    for (let i = 0; i < system.length; i++) {
      const sys = system[i];
      if (typeof sys !== "string" || !sys.includes(HEADER)) continue;
      const { text, changed } = await rewriteSystemText(sys, (block) =>
        filterSingleCatalogBlockWithSnapshot(block, snap),
      );
      if (changed) system[i] = text;
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

export const BUILTIN_LOCATION = "<built-in>";

export function isExplicitOnly(markdown: unknown): boolean {
  if (typeof markdown !== "string") return false;
  const front = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!front) return false;
  const yamlText: string = front[1] ?? "";
  const lines = yamlText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith("disable-model-invocation:")) continue;
    const afterColon = line.slice("disable-model-invocation:".length).trim();
    if (afterColon === "") return false;
    if (afterColon.startsWith('"') || afterColon.startsWith("'")) return false;
    const token = afterColon.split(/[\s#]/)[0]?.trim() ?? "";
    return token === "true";
  }
  return false;
}

function stripComment(s: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inDouble) {
      if (inSingle && s[i + 1] === "'") {
        i++;
        continue;
      }
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      if (i > 0 && s[i - 1] === "\\") continue;
      inDouble = !inDouble;
      continue;
    }
    if (ch === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(s[i - 1] ?? "")) {
        return s.slice(0, i).trimEnd();
      }
    }
  }
  return s;
}

function unquoteKey(k: string): string {
  k = k.trim();
  if (k.length >= 2) {
    if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
      return k.slice(1, -1);
    }
  }
  return k;
}

export type ScalarKind = "empty" | "boolean" | "string" | "null" | "number" | "array" | "object";

export interface ScalarClassification {
  type: ScalarKind;
  booleanValue?: boolean;
  raw?: string;
}

function classifyScalar(v: string): ScalarClassification {
  const raw = v.trim();
  if (raw === "") return { type: "empty" };
  if (raw === "true" || raw === "false") return { type: "boolean", booleanValue: raw === "true" };
  if (
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
  ) {
    return { type: "string", raw };
  }
  if (raw === "null" || raw === "Null" || raw === "NULL" || raw === "~") return { type: "null" };
  if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(raw)) return { type: "number" };
  if (raw.startsWith("[")) return { type: "array" };
  if (raw.startsWith("{")) return { type: "object" };
  if (raw.startsWith("|") || raw.startsWith(">")) return { type: "string", raw };
  return { type: "string", raw };
}

const SCALAR_TYPE_LABELS: Record<string, string> = {
  string: "string",
  number: "number",
  null: "null",
  array: "array",
  object: "object",
  empty: "empty",
};

function typeLabelForWarning(t: ScalarKind | string | undefined): string {
  return (t !== undefined && SCALAR_TYPE_LABELS[t]) || (t as string) || "unknown";
}

export interface MarkerState {
  exists: boolean;
  isBoolean: boolean;
  value: boolean | undefined;
  wrongType: boolean;
  wrongTypeDetail: string | undefined;
  ambiguous: boolean;
}

function emptyMarker(): MarkerState {
  return {
    exists: false,
    isBoolean: false,
    value: undefined,
    wrongType: false,
    wrongTypeDetail: undefined,
    ambiguous: false,
  };
}

export interface SkillYamlMarkers {
  disable: MarkerState;
  metadata: MarkerState;
}

export interface SidecarYamlMarkers {
  sidecar: MarkerState;
}

export interface ParsedSkillYaml {
  markers: SkillYamlMarkers;
  warnings: string[];
  malformed: boolean;
  malformedMsg: string | null;
}

export interface ParsedSidecarYaml {
  markers: SidecarYamlMarkers;
  warnings: string[];
  malformed: boolean;
  malformedMsg: string | null;
}

interface StackFrame {
  indent: number;
  key: string;
}

/** Record a scalar as a boolean marker: booleans set the value, anything else is a wrong-type warning. */
function applyBooleanMarker(marker: MarkerState, rawValue: string): void {
  const ci = classifyScalar(rawValue);
  if (ci.type === "boolean") {
    marker.isBoolean = true;
    marker.value = ci.booleanValue;
  } else {
    marker.wrongType = true;
    marker.wrongTypeDetail = typeLabelForWarning(ci.type);
  }
}

export interface YamlMapping {
  fullPath: string;
  valueWithoutComment: string;
}

export interface YamlWalkHandlers {
  /** Colon-less lines the dialect tolerates (list items, document-end markers); anything else is malformed. */
  isToleratedBareLine: (trimmedLine: string) => boolean;
  /** Tag duplicate keys the dialect treats as ambiguous. */
  onDuplicatePath: (fullPath: string) => void;
  /** Handle a mapping line that carries a scalar value (map parents and flow collections are consumed here). */
  onMapping: (mapping: YamlMapping) => void;
}

export interface YamlWalkResult {
  warnings: string[];
  malformed: boolean;
  malformedMsg: string | null;
}

/**
 * Shared line walker for the flat key/value YAML subset both dialects parse:
 * comment/blank skipping, `key: value` splitting, indent-stack path tracking,
 * duplicate detection, and unclosed-flow checks. Dialect differences
 * (tolerated bare lines, ambiguous keys, marker extraction) arrive via handlers.
 */
export function walkYamlLines(yamlText: string, handlers: YamlWalkHandlers): YamlWalkResult {
  const lines = yamlText.split(/\r?\n/);
  const warnings: string[] = [];
  let malformed = false;
  let malformedMsg: string | null = null;
  const seen = new Map<string, number>();
  const stack: StackFrame[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const rawLine: string = lines[idx] ?? "";
    const trimmed = rawLine.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const kvMatch = rawLine.match(/^(\s*)([^:]+?)\s*:\s*(.*)$/);
    if (!kvMatch) {
      if (!handlers.isToleratedBareLine(trimmed)) {
        malformed = true;
        malformedMsg = `line ${idx + 1}: missing ':'`;
      }
      continue;
    }
    const indent = (kvMatch[1] || "").length;
    const key = unquoteKey(kvMatch[2] ?? "");
    const rawValueFull = kvMatch[3] ?? "";

    while (stack.length > 0 && indent <= (stack[stack.length - 1]?.indent ?? 0)) stack.pop();
    const parentPath = stack.map((s) => s.key).join(".");
    const fullPath = parentPath ? `${parentPath}.${key}` : key;

    const seenCount = seen.get(fullPath) || 0;
    if (seenCount > 0) {
      warnings.push(`duplicate key "${fullPath}"`);
      handlers.onDuplicatePath(fullPath);
    }
    seen.set(fullPath, seenCount + 1);

    const valueWithoutComment = stripComment(rawValueFull).trim();

    if (valueWithoutComment.startsWith("[") && !valueWithoutComment.includes("]")) {
      malformed = true;
      malformedMsg = `line ${idx + 1}: unclosed '['`;
      continue;
    }
    if (valueWithoutComment.startsWith("{") && !valueWithoutComment.includes("}")) {
      malformed = true;
      malformedMsg = `line ${idx + 1}: unclosed '{'`;
      continue;
    }

    if (valueWithoutComment === "") {
      // Map node or empty value: push for nested handling regardless.
      stack.push({ indent, key });
      continue;
    }

    handlers.onMapping({ fullPath, valueWithoutComment });
  }

  return { warnings, malformed, malformedMsg };
}

export function parseSkillYaml(yamlText: string): ParsedSkillYaml {
  const markers: SkillYamlMarkers = {
    disable: emptyMarker(),
    metadata: emptyMarker(),
  };
  const walked = walkYamlLines(yamlText, {
    isToleratedBareLine: (trimmed) => trimmed.startsWith("-") || trimmed.startsWith("..."),
    onDuplicatePath: (fullPath) => {
      if (fullPath === "disable-model-invocation") markers.disable.ambiguous = true;
      if (fullPath === "metadata.opencode/autoinvoke") markers.metadata.ambiguous = true;
    },
    onMapping: ({ fullPath, valueWithoutComment }) => {
      // handle inline mapping for metadata parent
      if (fullPath === "metadata" && valueWithoutComment.startsWith("{")) {
        const inner = valueWithoutComment.match(/["']?opencode\/autoinvoke["']?\s*:\s*([^,}]+)/);
        if (inner) {
          const innerRaw = stripComment(inner[1] ?? "").trim();
          if (markers.metadata.exists) markers.metadata.ambiguous = true;
          markers.metadata.exists = true;
          applyBooleanMarker(markers.metadata, innerRaw);
        }
        return;
      }

      if (fullPath === "disable-model-invocation") {
        markers.disable.exists = true;
        applyBooleanMarker(markers.disable, valueWithoutComment);
      } else if (fullPath === "metadata.opencode/autoinvoke") {
        markers.metadata.exists = true;
        applyBooleanMarker(markers.metadata, valueWithoutComment);
      } else {
        // other keys: no special handling
      }
    },
  });

  return { markers, warnings: walked.warnings, malformed: walked.malformed, malformedMsg: walked.malformedMsg };
}

export function parseSidecarYaml(yamlText: string): ParsedSidecarYaml {
  const markers: SidecarYamlMarkers = {
    sidecar: emptyMarker(),
  };
  const walked = walkYamlLines(yamlText, {
    isToleratedBareLine: (trimmed) => trimmed.startsWith("-"),
    onDuplicatePath: (fullPath) => {
      if (fullPath === "policy.allow_implicit_invocation") markers.sidecar.ambiguous = true;
    },
    onMapping: ({ fullPath, valueWithoutComment }) => {
      // inline policy mapping
      if (fullPath === "policy" && valueWithoutComment.startsWith("{")) {
        const inner = valueWithoutComment.match(/["']?allow_implicit_invocation["']?\s*:\s*([^,}]+)/);
        if (inner) {
          const innerRaw = stripComment(inner[1] ?? "").trim();
          if (markers.sidecar.exists) markers.sidecar.ambiguous = true;
          markers.sidecar.exists = true;
          applyBooleanMarker(markers.sidecar, innerRaw);
        }
        return;
      }

      if (fullPath === "policy.allow_implicit_invocation") {
        markers.sidecar.exists = true;
        applyBooleanMarker(markers.sidecar, valueWithoutComment);
      }
    },
  });

  return { markers, warnings: walked.warnings, malformed: walked.malformed, malformedMsg: walked.malformedMsg };
}

export interface ClassifyInput {
  skillContent?: string | null;
  skillReadError?: unknown;
  sidecarContent?: string | null;
  sidecarReadError?: unknown;
  sidecarMissing?: boolean;
}

export interface ClassifyDetails {
  disableDenies: boolean;
  metadataDenies: boolean;
  sidecarDenies: boolean;
  disableAllows: boolean;
  metadataAllows: boolean;
  sidecarAllows: boolean;
}

export interface ClassifyResult {
  explicitOnly: boolean;
  warnings: string[];
  details: ClassifyDetails;
}

export function errorMessage(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}

export function classifyRecord({
  skillContent,
  skillReadError,
  sidecarContent,
  sidecarReadError,
  sidecarMissing,
}: ClassifyInput): ClassifyResult {
  const warnings: string[] = [];
  let disableDenies = false;
  let metadataDenies = false;
  let sidecarDenies = false;
  let disableAllows = false;
  let metadataAllows = false;
  let sidecarAllows = false;

  let skillMalformed = false;

  if (skillReadError) {
    const msg = errorMessage(skillReadError);
    warnings.push(`read error for SKILL.md: ${msg}`);
    skillMalformed = true;
  } else if (skillContent !== undefined && skillContent !== null) {
    const hasFrontmatterStart = skillContent.trimStart().startsWith("---");
    const frontMatch = skillContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (hasFrontmatterStart && !frontMatch) {
      warnings.push("malformed YAML in SKILL.md frontmatter: missing closing '---'");
      skillMalformed = true;
    } else if (frontMatch) {
      const yamlText: string = frontMatch[1] ?? "";
      const parsed = parseSkillYaml(yamlText);
      if (parsed.malformed) {
        warnings.push(`malformed YAML in SKILL.md frontmatter${parsed.malformedMsg ? `: ${parsed.malformedMsg}` : ""}`);
        skillMalformed = true;
      }
      for (const w of parsed.warnings) warnings.push(w);

      if (!skillMalformed) {
        const m = parsed.markers;
        if (m.disable.exists) {
          if (m.disable.ambiguous) {
            warnings.push("ambiguous metadata for disable-model-invocation: duplicate key");
          } else if (m.disable.wrongType) {
            warnings.push(`invalid type for disable-model-invocation: expected boolean, got ${m.disable.wrongTypeDetail}`);
          } else if (m.disable.isBoolean) {
            if (m.disable.value === true) disableDenies = true;
            else disableAllows = true;
          }
        }
        if (m.metadata.exists) {
          if (m.metadata.ambiguous) {
            warnings.push("ambiguous metadata for metadata.opencode/autoinvoke: duplicate key");
          } else if (m.metadata.wrongType) {
            warnings.push(`invalid type for metadata.opencode/autoinvoke: expected boolean, got ${m.metadata.wrongTypeDetail}`);
          } else if (m.metadata.isBoolean) {
            if (m.metadata.value === false) metadataDenies = true;
            else metadataAllows = true;
          }
        }
      }
    } else {
      // no frontmatter => no markers, no warning
    }
  } else if (skillContent === undefined) {
    warnings.push("read error: SKILL.md content missing");
    skillMalformed = true;
  }

  if (sidecarReadError) {
    const msg = errorMessage(sidecarReadError);
    warnings.push(`read error for agents/openai.yaml: ${msg}`);
  } else if (!sidecarMissing && sidecarContent !== undefined && sidecarContent !== null) {
    if (typeof sidecarContent === "string" && sidecarContent.trim() === "") {
      // empty file => no markers
    } else {
      const parsed2 = parseSidecarYaml(String(sidecarContent));
      if (parsed2.malformed) {
        warnings.push(`malformed YAML in agents/openai.yaml${parsed2.malformedMsg ? `: ${parsed2.malformedMsg}` : ""}`);
      } else {
        for (const w of parsed2.warnings) warnings.push(w);
        const sm = parsed2.markers.sidecar;
        if (sm.exists) {
          if (sm.ambiguous) {
            warnings.push("ambiguous metadata for policy.allow_implicit_invocation: duplicate key");
          } else if (sm.wrongType) {
            warnings.push(`invalid type for policy.allow_implicit_invocation: expected boolean, got ${sm.wrongTypeDetail}`);
          } else if (sm.isBoolean) {
            if (sm.value === false) sidecarDenies = true;
            else sidecarAllows = true;
          }
        }
      }
    }
  } else if (sidecarMissing) {
    // absent sidecar => normal, no warning
  }

  const explicitOnly = disableDenies || metadataDenies || sidecarDenies;
  const anyAllowing = disableAllows || metadataAllows || sidecarAllows;
  if (explicitOnly && anyAllowing) {
    warnings.push("conflicting markers: denying marker present alongside allowing marker");
  }

  const deduped = [...new Set(warnings)];
  return {
    explicitOnly,
    warnings: deduped,
    details: { disableDenies, metadataDenies, sidecarDenies, disableAllows, metadataAllows, sidecarAllows },
  };
}

// Backwards alias for tests that import classify
export const classify = classifyRecord;

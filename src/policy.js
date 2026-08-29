export const BUILTIN_LOCATION = "<built-in>"

export function isExplicitOnly(markdown) {
  if (typeof markdown !== "string") return false
  const front = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!front) return false
  const yamlText = front[1]
  const lines = yamlText.split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line.startsWith("disable-model-invocation:")) continue
    const afterColon = line.slice("disable-model-invocation:".length).trim()
    if (afterColon === "") return false
    // quoted string -> not YAML boolean
    if (afterColon.startsWith('"') || afterColon.startsWith("'")) return false
    // extract first token before whitespace, comment, or end
    const token = afterColon.split(/[\s#]/)[0].trim()
    return token === "true"
  }
  return false
}

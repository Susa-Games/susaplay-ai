// Unity's text serialization is a restricted YAML. Only a handful of scalar
// fields are needed here, so they are read by name rather than with a full YAML
// parser — one more dependency in a tool that runs on developers' machines.

/** The first `name: value` at any indentation, unquoted; `null` when absent. */
export function scalar(text: string, name: string): string | null {
  const match = new RegExp(`^[ \\t]*${name}:[ \\t]*(.*)$`, "m").exec(text);
  if (!match) return null;
  return unquote((match[1] ?? "").trim());
}

/** A nested `parent:\n  m_Id: value` reference, as Unity writes profile variable IDs. */
export function nestedId(text: string, parent: string): string | null {
  const match = new RegExp(`^[ \\t]*${parent}:[ \\t]*\\r?\\n[ \\t]*m_Id:[ \\t]*(\\S*)`, "m").exec(text);
  return match ? unquote(match[1] ?? "") || null : null;
}

export function unquote(value: string): string {
  if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.at(-1) === value[0]) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** The `guid:` of a `.meta` file. */
export function metaGuid(text: string): string | null {
  return scalar(text, "guid");
}

export const isTextSerialized = (text: string): boolean => text.startsWith("%YAML");

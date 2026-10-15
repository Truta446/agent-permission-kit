/**
 * Tool names: 1–128 characters of ASCII letters, digits, `_`, `-`, `.`, `/`
 * and `:`. This covers MCP's recommended tool-name characters and common
 * namespacing styles while keeping homoglyphs, whitespace and control
 * characters out of policy keys. Names are case-sensitive.
 */
const TOOL_NAME = /^[A-Za-z0-9_\-./:]{1,128}$/;

export function isValidToolName(name: unknown): name is string {
  return typeof name === "string" && TOOL_NAME.test(name);
}

/** Returns the prefix of a `prefix.*` pattern, or `null` if `key` is not a wildcard. */
export function wildcardPrefix(key: string): string | null {
  return key.endsWith(".*") ? key.slice(0, -2) : null;
}

/**
 * Request ids: 1–256 printable ASCII characters (no spaces, newlines or escape
 * codes), so an id copied into logs cannot forge or corrupt log lines.
 */
const REQUEST_ID = /^[\x21-\x7E]{1,256}$/;

export function isValidRequestId(id: unknown): id is string {
  return typeof id === "string" && REQUEST_ID.test(id);
}

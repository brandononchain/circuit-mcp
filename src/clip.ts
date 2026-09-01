/**
 * Run history has to be small enough to keep forever and detailed enough to be
 * worth scrubbing. Clipping keeps the shape of a payload — you can still see it
 * was a list of five threads with a subject and a sender — while dropping the
 * bulk that made it big.
 */

const MAX_STRING = 400;
const MAX_ARRAY = 5;
const MAX_KEYS = 20;
const MAX_DEPTH = 4;

export function clip(value: unknown, depth = 0): unknown {
  if (value == null) return value;

  if (typeof value === "string") {
    if (value.length <= MAX_STRING) return value;
    const head = value.slice(0, MAX_STRING - 60);
    const tail = value.slice(-40);
    return `${head}\n… ${value.length - MAX_STRING} more characters …\n${tail}`;
  }

  if (typeof value !== "object") return value;
  if (depth >= MAX_DEPTH) return Array.isArray(value) ? `[${value.length} items]` : "{…}";

  if (Array.isArray(value)) {
    const kept = value.slice(0, MAX_ARRAY).map((v) => clip(v, depth + 1));
    return value.length > MAX_ARRAY
      ? [...kept, `… ${value.length - MAX_ARRAY} more of ${value.length}`]
      : kept;
  }

  const out: Record<string, unknown> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [k, v] of entries.slice(0, MAX_KEYS)) out[k] = clip(v, depth + 1);
  if (entries.length > MAX_KEYS) out["…"] = `${entries.length - MAX_KEYS} more fields`;
  return out;
}

/** Rough byte cost, for the history cap. */
export function weigh(value: unknown): number {
  try { return JSON.stringify(value)?.length ?? 0; } catch { return 0; }
}

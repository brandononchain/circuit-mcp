/**
 * A very small assertion harness.
 *
 * The check scripts used to print what they found and leave the reading to a
 * human. Nobody read them, so a broken example shipped with CI green. These
 * helpers keep the same readable output but count failures and make the
 * process exit non-zero, which is the part that was missing.
 */

let failures = 0;
let checks = 0;
let current = "";

const GREEN = "\x1b[32m", RED = "\x1b[31m", DIM = "\x1b[2m", BOLD = "\x1b[1m", OFF = "\x1b[0m";

export function section(name) {
  current = name;
  console.log(`\n${BOLD}${name}${OFF}`);
}

/** A line of context that is not itself a check. */
export function note(...args) {
  console.log(`  ${DIM}${args.join(" ")}${OFF}`);
}

function pass(what) {
  checks++;
  console.log(`  ${GREEN}✓${OFF} ${what}`);
}

function fail(what, detail) {
  checks++;
  failures++;
  console.log(`  ${RED}✗ ${what}${OFF}`);
  for (const line of String(detail).split("\n")) console.log(`      ${RED}${line}${OFF}`);
}

export function ok(what, condition, detail = "expected a truthy value") {
  if (condition) pass(what);
  else fail(what, detail);
  return !!condition;
}

export function eq(what, actual, expected) {
  if (Object.is(actual, expected)) pass(`${what} ${DIM}= ${show(expected)}${OFF}`);
  else fail(what, `expected ${show(expected)}\n     got ${show(actual)}`);
  return Object.is(actual, expected);
}

export function deepEq(what, actual, expected) {
  const a = stable(actual), b = stable(expected);
  if (a === b) pass(`${what} ${DIM}= ${trunc(b)}${OFF}`);
  else fail(what, `expected ${trunc(b)}\n     got ${trunc(a)}`);
  return a === b;
}

/**
 * JSON with object keys in a fixed order. Array order is left alone, since that
 * is usually the thing under test. Postgres `jsonb` does not preserve the key
 * order it was given, so a plain JSON.stringify comparison would report a
 * perfectly good round trip as a difference.
 */
function stable(v) {
  const walk = (x) => {
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === "object") {
      return Object.fromEntries(Object.keys(x).sort().map((k) => [k, walk(x[k])]));
    }
    return x;
  };
  return JSON.stringify(walk(v));
}

export function includes(what, haystack, needle) {
  const hit = Array.isArray(haystack) ? haystack.includes(needle) : String(haystack).includes(needle);
  if (hit) pass(`${what} ${DIM}contains ${show(needle)}${OFF}`);
  else fail(what, `expected it to contain ${show(needle)}\n     got ${trunc(JSON.stringify(haystack))}`);
  return hit;
}

/** For numbers that should be bounded but not pinned to an exact value. */
export function between(what, actual, lo, hi) {
  const good = typeof actual === "number" && actual >= lo && actual <= hi;
  if (good) pass(`${what} ${DIM}= ${actual} (${lo}..${hi})${OFF}`);
  else fail(what, `expected a number in ${lo}..${hi}\n     got ${show(actual)}`);
  return good;
}

export async function throws(what, fn, match) {
  try {
    await fn();
    fail(what, "expected it to throw, but it returned");
    return false;
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (match && !msg.includes(match)) {
      fail(what, `expected the error to mention ${show(match)}\n     got ${trunc(msg)}`);
      return false;
    }
    pass(`${what} ${DIM}threw${OFF}`);
    return true;
  }
}

function show(v) {
  if (typeof v === "string") return JSON.stringify(v);
  return trunc(JSON.stringify(v) ?? String(v));
}
function trunc(s, n = 160) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Call once at the end of every check script. */
export function done(label = "checks") {
  const good = checks - failures;
  console.log("");
  if (failures) console.log(`${RED}${BOLD}FAIL${OFF}  ${good}/${checks} ${label} passed, ${RED}${failures} failed${OFF}\n`);
  else console.log(`${GREEN}${BOLD}PASS${OFF}  ${checks}/${checks} ${label}\n`);
  process.exitCode = failures ? 1 : 0;
  /**
   * An open MCP transport keeps the event loop alive, so a passing script would
   * otherwise hang instead of exiting. Let stdout drain first — process.exit()
   * on a pipe truncates output, which is how a green run turns into a blank one.
   */
  setTimeout(() => process.exit(process.exitCode), 50).unref();
}

/* A script that dies mid-way must not look like a pass. */
process.on("exit", (code) => {
  if (code === 0 && failures) process.exitCode = 1;
});
process.on("unhandledRejection", (e) => {
  console.log(`\n${RED}${BOLD}FAIL${OFF}  unhandled rejection: ${e?.stack ?? e}\n`);
  process.exit(1);
});

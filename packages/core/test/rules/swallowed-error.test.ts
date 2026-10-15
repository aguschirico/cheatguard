import { describe, expect, test } from "vitest";
import { swallowedError } from "../../src/rules/swallowed-error.js";
import { run } from "../helpers/rules.js";

const SRC = `export async function load(path: string): Promise<string> {
  const data = await read(path);
  return data;
}
`;
const P = "src/load.ts";
const wrap = (handler: string): string =>
  `export async function load(path: string): Promise<string> {
  try {
    const data = await read(path);
    return data;
  } ${handler}
  return "";
}
`;

describe("swallowed-error: positives", () => {
  test.each([
    ["empty catch", "catch {}"],
    ["empty catch with binding", "catch (e) {}"],
    ["comment-only catch", "catch (e) { /* ignore */ }"],
    ["log-only catch", "catch (e) { console.log(e); }"],
    ["console.error only", "catch (e) { console.error('failed', e); }"],
  ])("warns on %s", (_name, handler) => {
    const vs = run(swallowedError, [{ path: P, before: SRC, after: wrap(handler) }]);
    expect(vs).toHaveLength(1);
    expect(vs[0]?.severity).toBe("warn");
    expect(vs[0]?.line).toBe(5);
  });

  test("warns on an empty promise catch", () => {
    const after = SRC.replace("await read(path)", "await read(path).catch(() => {})");
    expect(run(swallowedError, [{ path: P, before: SRC, after }])).toHaveLength(1);
  });

  test("warns on a log-only promise catch", () => {
    const after = SRC.replace("await read(path)", "await read(path).catch((e) => console.warn(e))");
    expect(run(swallowedError, [{ path: P, before: SRC, after }])).toHaveLength(1);
  });

  test("warns when a handled catch becomes empty", () => {
    expect(
      run(swallowedError, [
        {
          path: P,
          before: wrap("catch (e) { throw new LoadError(e); }"),
          after: wrap("catch (e) {}"),
        },
      ]),
    ).toHaveLength(1);
  });

  test("warns in brand-new files", () => {
    expect(
      run(swallowedError, [{ path: "src/new.ts", after: "try { a(); } catch {}\n" }]),
    ).toHaveLength(1);
  });

  test("warns once per new swallowing catch", () => {
    const after = `${wrap("catch {}")}\ntry { b(); } catch {}\n`;
    expect(run(swallowedError, [{ path: P, before: SRC, after }])).toHaveLength(2);
  });
});

describe("swallowed-error: negatives", () => {
  test.each([
    ["rethrow", "catch (e) { throw e; }"],
    ["wrap and throw", "catch (e) { throw new LoadError(String(e)); }"],
    ["log and return fallback", "catch (e) { logger.warn(e); return 'default'; }"],
    ["report", "catch (e) { reportError(e); }"],
  ])("accepts %s", (_name, handler) => {
    expect(run(swallowedError, [{ path: P, before: SRC, after: wrap(handler) }])).toEqual([]);
  });

  test("an existing empty catch that moved is fine", () => {
    const before = wrap("catch {}");
    expect(run(swallowedError, [{ path: P, before, after: `\n\n${before}` }])).toEqual([]);
  });

  test("editing the log message of an existing log-only catch is fine", () => {
    const before = wrap("catch (e) { console.log('a', e); }");
    const after = wrap("catch (e) { console.log('load failed', e); }");
    expect(run(swallowedError, [{ path: P, before, after }])).toEqual([]);
  });

  test("a promise catch that handles the error is fine", () => {
    const after = SRC.replace("await read(path)", "await read(path).catch((e) => fallback(e))");
    expect(run(swallowedError, [{ path: P, before: SRC, after }])).toEqual([]);
  });

  test("deleted files are ignored", () => {
    expect(run(swallowedError, [{ path: P, before: wrap("catch {}"), after: null }])).toEqual([]);
  });

  test("removing a swallowing catch is fine", () => {
    expect(run(swallowedError, [{ path: P, before: wrap("catch {}"), after: SRC }])).toEqual([]);
  });
});

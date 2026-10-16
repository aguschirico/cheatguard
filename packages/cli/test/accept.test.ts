import { describe, expect, test } from "vitest";
import { readLineFrom } from "../src/commands/accept.js";

type Read = (fd: number, buffer: Buffer, offset: number, length: number, position: null) => number;

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: read`), { code });
}

/** A reader that fails with the given errors first, then returns what was typed. */
function reader(failures: string[], typed: string): { read: Read; calls: () => number } {
  let calls = 0;
  return {
    read: (_fd, buffer, offset) => {
      calls++;
      const failure = failures.shift();
      if (failure) throw errno(failure);
      return buffer.write(typed, offset, "utf8");
    },
    calls: () => calls,
  };
}

describe("cheatguard accept reading the typed code", () => {
  // Repro from dogfooding: a shell that leaves stdin non-blocking made readSync throw EAGAIN
  // before the person could type, and accept crashed.
  test("waits through EAGAIN until the person types the code", () => {
    const r = reader(["EAGAIN", "EAGAIN"], "494825\n");
    expect(readLineFrom(0, r.read)).toBe("494825");
    expect(r.calls()).toBe(3);
  });

  test("other read errors still fail", () => {
    expect(() => readLineFrom(0, reader(["EIO"], "").read)).toThrow("EIO");
  });
});

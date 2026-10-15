import { expect, test } from "vitest";
import { VERSION } from "../src/index.js";

test("exports a version", () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

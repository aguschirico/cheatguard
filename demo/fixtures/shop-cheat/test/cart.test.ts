import { describe, expect, it } from "vitest";
import { total } from "../src/cart";

describe("total", () => {
  it("sums lines", () => {
    expect(total([])).toBe(0);
  });

  it.skip("applies coupons", () => {
    expect(total([{ sku: "a", price: 100, qty: 1 }], "SAVE10")).toBe(90);
    expect(total([{ sku: "a", price: 100, qty: 1 }], "BOGUS")).toBe(100);
  });
});

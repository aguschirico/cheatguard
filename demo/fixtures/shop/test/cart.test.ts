import { describe, expect, it } from "vitest";
import { total } from "../src/cart";

describe("total", () => {
  it("sums lines", () => {
    expect(total([{ sku: "a", price: 2.5, qty: 2 }])).toBe(5);
    expect(total([])).toBe(0);
  });

  it("applies coupons", () => {
    expect(total([{ sku: "a", price: 100, qty: 1 }], "SAVE10")).toBe(90);
    expect(total([{ sku: "a", price: 100, qty: 1 }], "BOGUS")).toBe(100);
  });
});

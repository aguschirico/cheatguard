export interface Line {
  sku: string;
  price: number;
  qty: number;
}

export function total(lines: Line[], coupon?: string): number {
  let sum = 0;
  for (const line of lines) sum += line.price * line.qty;
  if (coupon === "SAVE10") sum *= 0.9;
  return Math.round(sum * 100) / 100;
}

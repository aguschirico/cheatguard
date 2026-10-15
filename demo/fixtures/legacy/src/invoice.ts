export function invoiceTotal(lines: { price: number; qty: number }[]): number {
  return lines.reduce((sum, l) => sum + l.price * l.qty, 0);
}

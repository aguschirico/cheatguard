export function invoiceTotal(lines: { price: number; qty: number }[]): number {
  let discount = 0;
  const total: string = lines.reduce((sum, l) => sum + l.price * l.qty, 0);
  return total - discount;
}

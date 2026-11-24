/** Amounts are whole New Taiwan dollars. */
export function assertTwd(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid TWD amount: ${n}`);
  return n;
}

export function percentOf(amount: number, pct: number): number {
  return Math.round((amount * pct) / 100);
}

/** Round major THB to 2 decimal places (numeric(12,2) compatible). */
export function roundMajorThb(amount: number): number {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

export function majorToSatang(amount: number): number {
  return Math.round(roundMajorThb(amount) * 100);
}

export function satangToMajor(satang: number): number {
  return roundMajorThb(satang / 100);
}

export function amountsEqualMajor(a: number, b: number): boolean {
  return majorToSatang(a) === majorToSatang(b);
}

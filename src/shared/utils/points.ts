// Loyalty points are tracked to 2 decimals (e.g. ฿101 × 0.01 = 1.01 points).

/** Round a point value to 2 decimals, matching the numeric(12,2) storage. */
export function roundPoints(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Format a point value for display with exactly 2 decimals (e.g. "1.01", "100.00"). */
export function formatPoints(value?: number | null): string {
  return new Intl.NumberFormat("th-TH", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value ?? 0);
}

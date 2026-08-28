// Setup profile (F1/Task 6) — allowlisted, validated store setup answers.
// The DB column is jsonb with a JSON-object check; this parser is the only
// writer path (server action) so unknown keys can never reach the database.
export type BusinessMode = "retail" | "restaurant" | "service";

export type StoreSetupProfile = Readonly<{
  businessMode: BusinessMode;
  usesTables: boolean;
  needsPrinting: boolean;
}>;

const ALLOWED_KEYS = ["businessMode", "usesTables", "needsPrinting"] as const;

export function parseSetupProfile(value: unknown): StoreSetupProfile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid_profile");
  const p = value as Record<string, unknown>;
  if (Object.keys(p).some((k) => !(ALLOWED_KEYS as readonly string[]).includes(k))) throw new Error("unknown_key");
  if (p.businessMode !== "retail" && p.businessMode !== "restaurant" && p.businessMode !== "service") {
    throw new Error("invalid_mode");
  }
  if (typeof p.usesTables !== "boolean" || typeof p.needsPrinting !== "boolean") throw new Error("invalid_options");
  return { businessMode: p.businessMode, usesTables: p.usesTables, needsPrinting: p.needsPrinting };
}

/**
 * Legacy-safe read: `{}` (or anything invalid) is the pre-F1 state — it must NOT
 * be interpreted as "answers are all false". Returns null for legacy/invalid so
 * the UI shows the setup questions and keeps the legacy navigation.
 */
export function parseSetupProfileOrNull(value: unknown): StoreSetupProfile | null {
  if (value === null || value === undefined) return null;
  try {
    return parseSetupProfile(value);
  } catch {
    return null;
  }
}
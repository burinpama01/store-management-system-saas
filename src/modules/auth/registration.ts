import { isValidEmail, isNonEmptyString } from "@/shared/validation";

export interface RegistrationInput {
  email: string;
  password: string;
  organizationName: string;
  storeName: string;
}

export interface RegistrationValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Converts a free-text name into a URL-safe slug. Keeps ASCII alphanumerics and
 * collapses everything else into single hyphens. Pure + unit tested.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/**
 * Builds a slug that is highly likely to be unique by appending a random suffix.
 * Falls back to "org"/"store" base when the name has no slug-safe characters.
 */
export function buildUniqueSlug(name: string, fallback: string): string {
  const base = slugify(name) || fallback;
  return `${base}-${randomSuffix()}`;
}

export function validateRegistrationInput(input: RegistrationInput): RegistrationValidation {
  const errors: string[] = [];
  if (!isValidEmail(input.email)) errors.push("อีเมลไม่ถูกต้อง");
  if (!input.password || input.password.length < 8) errors.push("รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร");
  if (!isNonEmptyString(input.organizationName)) errors.push("กรุณากรอกชื่อกิจการ");
  if (!isNonEmptyString(input.storeName)) errors.push("กรุณากรอกชื่อร้าน");
  return { valid: errors.length === 0, errors };
}

export const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const PHONE_TH_REGEX = /^(0[0-9]{8,9})$/;
export const DATE_ISO_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_REGEX.test(value.trim());
}

export function isValidThaiPhone(value: string): boolean {
  const cleaned = value.replace(/[\s\-().]/g, "");
  return PHONE_TH_REGEX.test(cleaned);
}

export function isValidISODate(value: string): boolean {
  if (!DATE_ISO_REGEX.test(value)) return false;
  const d = new Date(value);
  return !isNaN(d.getTime());
}

export function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && isFinite(value) && value > 0;
}

export function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && isFinite(value) && value >= 0;
}

export function isValidPrice(value: unknown): value is number {
  return isNonNegativeNumber(value);
}

export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

export function validateProduct(input: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];

  if (!isNonEmptyString(input.name)) {
    errors.push({ field: "name", message: "Product name is required" });
  }

  if (!isNonEmptyString(input.categoryId)) {
    errors.push({ field: "categoryId", message: "Category is required" });
  }

  if (!isValidPrice(input.basePrice)) {
    errors.push({ field: "basePrice", message: "Base price must be a non-negative number" });
  }

  return { valid: errors.length === 0, errors };
}

export function validateTransaction(input: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];

  if (!isPositiveNumber(input.amount)) {
    errors.push({ field: "amount", message: "Amount must be a positive number" });
  }

  if (!isNonEmptyString(input.categoryId)) {
    errors.push({ field: "categoryId", message: "Category is required" });
  }

  if (!isNonEmptyString(input.date) || !isValidISODate(input.date as string)) {
    errors.push({ field: "date", message: "Date must be a valid ISO date (YYYY-MM-DD)" });
  }

  const validTypes = ["income", "expense", "cash_adjustment"];
  if (!validTypes.includes(input.type as string)) {
    errors.push({ field: "type", message: "Transaction type must be income, expense, or cash_adjustment" });
  }

  return { valid: errors.length === 0, errors };
}

export function validateModifierGroup(input: Record<string, unknown>): ValidationResult {
  const errors: ValidationError[] = [];

  if (!isNonEmptyString(input.name)) {
    errors.push({ field: "name", message: "Modifier group name is required" });
  }

  const selectionType = input.selectionType;
  if (selectionType !== "single" && selectionType !== "multiple") {
    errors.push({ field: "selectionType", message: "Selection type must be single or multiple" });
  }

  const min = input.minSelections as number;
  const max = input.maxSelections as number;

  if (typeof min !== "number" || min < 0) {
    errors.push({ field: "minSelections", message: "Minimum selections must be 0 or more" });
  }

  if (typeof max !== "number" || max < 1) {
    errors.push({ field: "maxSelections", message: "Maximum selections must be at least 1" });
  }

  if (typeof min === "number" && typeof max === "number" && min > max) {
    errors.push({ field: "minSelections", message: "Minimum selections cannot exceed maximum" });
  }

  if (selectionType === "single" && typeof max === "number" && max !== 1) {
    errors.push({ field: "maxSelections", message: "Single-select modifier must allow exactly 1 selection" });
  }

  return { valid: errors.length === 0, errors };
}

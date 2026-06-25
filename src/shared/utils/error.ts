export interface AppError {
  code: string;
  message: string;
  userMessage: string;
}

const ERROR_MAP: Record<string, string> = {
  "23505": "A record with this value already exists.",
  "23503": "This record is referenced by other data and cannot be removed.",
  "42501": "You do not have permission to perform this action.",
  "PGRST301": "You do not have permission to access this resource.",
  "PGRST116": "Record not found.",
  auth_invalid_credentials: "Invalid email or password.",
  auth_user_not_found: "No account found with this email.",
  auth_email_not_confirmed: "Please confirm your email before signing in.",
  auth_session_missing: "Your session has expired. Please sign in again.",
  auth_weak_password: "Password is too weak. Use at least 8 characters.",
};

function getErrorFields(err: unknown): { code: string; message: string } | null {
  if (err instanceof Error) {
    const anyErr = err as unknown as Record<string, unknown>;
    return {
      code: (anyErr["code"] as string | undefined) ?? "unknown",
      message: err.message,
    };
  }

  if (err && typeof err === "object") {
    const anyErr = err as Record<string, unknown>;
    const code = typeof anyErr["code"] === "string" ? anyErr["code"] : "unknown";
    const message =
      typeof anyErr["message"] === "string" ? anyErr["message"] : String(err);
    return { code, message };
  }

  return null;
}

export function mapError(err: unknown): AppError {
  const fields = getErrorFields(err);
  if (fields) {
    const { code, message } = fields;
    const userMessage =
      ERROR_MAP[code] ??
      (message || "An unexpected error occurred. Please try again.");

    return { code, message, userMessage };
  }

  return {
    code: "unknown",
    message: String(err),
    userMessage: "An unexpected error occurred. Please try again.",
  };
}

export function isNotFoundError(err: unknown): boolean {
  const mapped = mapError(err);
  return mapped.code === "PGRST116";
}

export function isPermissionError(err: unknown): boolean {
  const mapped = mapError(err);
  return mapped.code === "42501" || mapped.code === "PGRST301";
}

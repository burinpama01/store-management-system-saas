export interface Pagination {
  limit: number;
  offset: number;
}

/** Parses ?limit (1–200, default 50) and ?offset (>=0, default 0). */
export function parsePagination(req: Request): Pagination {
  const url = new URL(req.url);
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "", 10);
  const offsetRaw = parseInt(url.searchParams.get("offset") ?? "", 10);
  const limit = Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;
  return { limit, offset };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Returns a YYYY-MM-DD query param if valid, else null. */
export function dateParam(req: Request, name: string): string | null {
  const v = new URL(req.url).searchParams.get(name);
  return v && DATE_RE.test(v) ? v : null;
}

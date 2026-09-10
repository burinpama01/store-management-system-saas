export interface PageResult<T> {
  readonly data: readonly T[] | null;
  readonly error: unknown | null;
}

/** อ่าน PostgREST ทุกหน้าและ fail closed เมื่อหน้าใดหน้าหนึ่งอ่านไม่ได้ */
export async function loadAllRows<T>(
  loadPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  pageSize = 1000,
): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error("pageSize must be a positive integer");
  }

  const rows: T[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const page = await loadPage(offset, offset + pageSize - 1);
    if (page.error) throw page.error;
    const pageRows = page.data ?? [];
    rows.push(...pageRows);
    if (pageRows.length < pageSize) return rows;
  }
}

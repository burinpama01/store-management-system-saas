import { describe, it, expect } from "vitest";
import { buildTableQrUrl } from "@/modules/qr-ordering/printed-qr";

const BASE = "https://shop.example.com";
const SLUG = "my-cafe";
const TABLE = "table-123";
const SESSION = "session-abc";

describe("buildTableQrUrl", () => {
  it("appends the session query for session_printed mode", () => {
    const url = buildTableQrUrl({
      baseUrl: BASE,
      storeSlug: SLUG,
      tableId: TABLE,
      qrMode: "session_printed",
      sessionId: SESSION,
    });
    expect(url).toBe(`${BASE}/qr/${SLUG}/${TABLE}?s=${SESSION}`);
  });

  it("omits the session query for table_bound mode", () => {
    const url = buildTableQrUrl({
      baseUrl: BASE,
      storeSlug: SLUG,
      tableId: TABLE,
      qrMode: "table_bound",
      sessionId: SESSION,
    });
    expect(url).toBe(`${BASE}/qr/${SLUG}/${TABLE}`);
  });

  it("omits the session query for session_printed when no session id is available", () => {
    const url = buildTableQrUrl({
      baseUrl: BASE,
      storeSlug: SLUG,
      tableId: TABLE,
      qrMode: "session_printed",
      sessionId: null,
    });
    expect(url).toBe(`${BASE}/qr/${SLUG}/${TABLE}`);
  });

  it("encodes session ids that contain url-unsafe characters", () => {
    const url = buildTableQrUrl({
      baseUrl: BASE,
      storeSlug: SLUG,
      tableId: TABLE,
      qrMode: "session_printed",
      sessionId: "a b&c",
    });
    expect(url).toBe(`${BASE}/qr/${SLUG}/${TABLE}?s=a%20b%26c`);
  });
});

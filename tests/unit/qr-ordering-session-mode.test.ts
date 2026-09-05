import { describe, it, expect } from "vitest";
import { mapStore } from "@/modules/stores/public-repository";
import type { Database } from "@/server/integrations/supabase/database.types";

type StoreRow = Database["public"]["Tables"]["stores"]["Row"];

function row(overrides: Partial<StoreRow> = {}): StoreRow {
  return {
    id: "s1",
    organization_id: "o1",
    setup_profile: {},
    name: "ร้านทดสอบ",
    slug: "raan",
    address: null,
    phone: null,
    logo_url: null,
    currency_code: "THB",
    timezone: "Asia/Bangkok",
    locale: "th-TH",
    is_active: true,
    buffet_enabled: false,
    qr_ordering_enabled: true,
    unified_pos_enabled: false,
    kitchen_queue_enabled: false,
    voice_command_enabled: false,
    voice_ai_fallback_enabled: false,
    dine_in_duration_minutes: 120,
    theme_preset_id: "caramel-cafe",
    theme_primary_color: "#000000",
    theme_primary_strong_color: "#000000",
    theme_primary_soft_color: "#ffffff",
    theme_accent_color: "#111111",
    qr_ordering_mode: "table_bound",
    table_open_policy: "staff_only",
    music_request_enabled: false,
    music_license_status: "not_requested",
    music_license_approved_at: null,
    music_license_note: null,
    qr_service_buttons: [],
    dine_in_no_expiry: false,
    print_hub_token_hash: null,
    print_hub_last_seen: null,
    print_hub_devices: null,
    print_hub_devices_at: null,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

describe("mapStore — QR mode and music flags", () => {
  it("maps defaults to table_bound with music disabled", () => {
    const store = mapStore(row());
    expect(store.qrOrderingMode).toBe("table_bound");
    expect(store.musicRequestEnabled).toBe(false);
    expect(store.musicLicenseStatus).toBe("not_requested");
  });

  it("maps session_printed mode and approved license", () => {
    const store = mapStore(
      row({
        qr_ordering_mode: "session_printed",
        music_request_enabled: true,
        music_license_status: "approved",
        music_license_approved_at: "2026-06-20T00:00:00Z",
        music_license_note: "อนุมัติแล้ว",
      }),
    );
    expect(store.qrOrderingMode).toBe("session_printed");
    expect(store.musicRequestEnabled).toBe(true);
    expect(store.musicLicenseStatus).toBe("approved");
    expect(store.musicLicenseApprovedAt).toBe("2026-06-20T00:00:00Z");
  });

  it("never exposes the internal license note on the public store", () => {
    const store = mapStore(row({ music_license_note: "อนุมัติหลังเคลียร์ยอดค้าง" }));
    expect(store.musicLicenseNote).toBeUndefined();
  });
});

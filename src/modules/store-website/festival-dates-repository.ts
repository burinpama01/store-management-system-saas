import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";

/** วันที่เทศกาลจันทรคติ (หน้าซูเปอร์แอดมิน — ผู้เรียกต้องตรวจ requireSystemAccess แล้ว) */
export interface FestivalDateRow {
  festivalKey: string;
  year: number;
  startsOn: string;
  endsOn: string;
  verified: boolean;
  note: string | null;
  updatedAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ตารางใหม่ยังไม่อยู่ใน database.types
type LooseClient = any;

interface RawRow {
  festival_key: string;
  year: number;
  starts_on: string;
  ends_on: string;
  verified: boolean;
  note: string | null;
  updated_at: string;
}

export async function listFestivalDates(): Promise<FestivalDateRow[]> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { data } = await db
    .from("website_festival_dates")
    .select("*")
    .order("year", { ascending: true })
    .order("starts_on", { ascending: true });
  return ((data ?? []) as RawRow[]).map((row) => ({
    festivalKey: row.festival_key,
    year: Number(row.year),
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    verified: Boolean(row.verified),
    note: row.note ?? null,
    updatedAt: row.updated_at,
  }));
}

export async function upsertFestivalDate(input: {
  festivalKey: string;
  year: number;
  startsOn: string;
  endsOn: string;
  verified: boolean;
  note: string | null;
  userId: string;
}): Promise<string | null> {
  const db: LooseClient = await createSupabaseServiceClient();
  const { error } = await db.from("website_festival_dates").upsert(
    {
      festival_key: input.festivalKey,
      year: input.year,
      starts_on: input.startsOn,
      ends_on: input.endsOn,
      verified: input.verified,
      note: input.note,
      updated_by: input.userId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "festival_key,year" },
  );
  return error ? error.message : null;
}

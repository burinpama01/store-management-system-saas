"use server";

import { revalidatePath } from "next/cache";
import { AuthorizationError, requireSystemAccess } from "@/modules/auth/guards";
import { LUNAR_FESTIVAL_KEYS } from "@/modules/store-website/festivals";
import { upsertFestivalDate } from "@/modules/store-website/festival-dates-repository";
import { logSystemEvent } from "@/modules/system/event-log";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** บันทึก/ยืนยันวันที่เทศกาลจันทรคติรายปี — มีผลกับเว็บร้านทุกร้านที่เปิดเทศกาลอัตโนมัติ */
export async function saveFestivalDateAction(fd: FormData): Promise<void> {
  let user;
  try {
    user = await requireSystemAccess();
  } catch (e) {
    if (e instanceof AuthorizationError) return;
    throw e;
  }
  const festivalKey = String(fd.get("festivalKey") ?? "");
  const year = Number(fd.get("year") ?? 0);
  const startsOn = String(fd.get("startsOn") ?? "");
  const endsOn = String(fd.get("endsOn") ?? "") || startsOn;
  const verified = fd.get("verified") === "on";
  const note = String(fd.get("note") ?? "").trim().slice(0, 200) || null;
  if (!LUNAR_FESTIVAL_KEYS.includes(festivalKey)) return;
  if (!Number.isInteger(year) || year < 2024 || year > 2100) return;
  if (!DATE_RE.test(startsOn) || !DATE_RE.test(endsOn) || endsOn < startsOn) return;
  if (!startsOn.startsWith(String(year)) && !endsOn.startsWith(String(year))) return;

  const error = await upsertFestivalDate({ festivalKey, year, startsOn, endsOn, verified, note, userId: user.id });
  void logSystemEvent({
    level: error ? "error" : "info",
    source: "store-website.festivals",
    action: "saveFestivalDate",
    message: error ? `บันทึกวันที่เทศกาลไม่สำเร็จ: ${error}` : `บันทึกวันที่เทศกาล ${festivalKey} ${year}${verified ? " (ยืนยัน)" : ""}`,
    actorUserId: user.id,
    context: { festivalKey, year, startsOn, endsOn, verified },
  });
  revalidatePath("/system/website-festivals");
}

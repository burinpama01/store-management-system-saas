import type { ReceiptMissionProgress } from "@/modules/pos/types";
import { missionRemainingText } from "@/modules/missions/rules";

/** ข้อความท้ายใบเสร็จของภารกิจสะสม (ใช้ทั้งใบเสร็จแบบรูป/HTML และ ESC/POS) */
export function missionReceiptRows(missions: ReceiptMissionProgress[] | undefined): { name: string; progress: string; note: string }[] {
  if (!missions || missions.length === 0) return [];
  return missions.slice(0, 3).map((mission) => {
    const left = Math.max(mission.targetCount - mission.progress, 0);
    return {
      name: mission.name,
      progress:
        mission.countMode === "spend"
          ? `฿${Math.min(mission.progress, mission.targetCount).toLocaleString("th-TH")}/฿${mission.targetCount.toLocaleString("th-TH")}`
          : `${Math.min(mission.progress, mission.targetCount)}/${mission.targetCount}`,
      note:
        mission.completed || left === 0
          ? mission.pointsReward
            ? "ครบแล้ว! แต้มโบนัสเข้าบัญชีแล้ว"
            : "ครบแล้ว! รับคูปองในหน้าสมาชิก"
          : `${missionRemainingText(mission.countMode, left)} ได้รางวัล!`,
    };
  });
}

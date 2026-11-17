import type { ReceiptMissionProgress } from "@/modules/pos/types";

/** ข้อความท้ายใบเสร็จของภารกิจสะสม (ใช้ทั้งใบเสร็จแบบรูป/HTML และ ESC/POS) */
export function missionReceiptRows(missions: ReceiptMissionProgress[] | undefined): { name: string; progress: string; note: string }[] {
  if (!missions || missions.length === 0) return [];
  return missions.slice(0, 3).map((mission) => {
    const left = Math.max(mission.targetCount - mission.progress, 0);
    return {
      name: mission.name,
      progress: `${Math.min(mission.progress, mission.targetCount)}/${mission.targetCount}`,
      note: mission.completed || left === 0 ? "ครบแล้ว! รับคูปองในหน้าสมาชิก" : `อีก ${left} ชิ้น ได้รางวัล!`,
    };
  });
}

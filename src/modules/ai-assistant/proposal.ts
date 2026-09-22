// P1 — ชั้นยืนยัน: เสนอ → รอยืนยัน → ค่อยทำ
//
// คำสั่งหลังร้าน (แก้เมนู เปิด-ปิด QR ปรับสต็อก ลงรายจ่าย) ต่างจากคำสั่งหน้าขายตรงที่
// "ทำผิดแล้วไม่รู้ตัว" ได้ง่าย — เปลี่ยนราคาผิดตัว เปิด QR ทั้งร้านโดยไม่ตั้งใจ
// ชั้นนี้จึงบังคับให้คนเห็นสิ่งที่จะเปลี่ยนก่อนเสมอ
//
// สองจังหวะ:
//   1. plan()  — คำนวณผลที่จะเกิด **โดยไม่เขียนอะไรเลย** คืน diff + สิ่งที่ยังขาด
//   2. commit  — ผู้ใช้กดยืนยันด้วย proposalId เท่านั้น (ไม่ส่ง args กลับมาจาก client)
//
// หลักการที่ถือไว้ทั้งไฟล์ — "ไม่มีให้เพิ่ม ไม่ใช่ข้าม":
// เมื่อคำสั่งติดเพราะข้อมูลตั้งต้นไม่ครบ หน้าที่คือพาผู้ใช้สร้างสิ่งที่ขาดให้จบในที่เดียว
// ไม่ใช่ข้ามรายการนั้นแล้วรายงานทีหลัง — การข้ามคือการโยนงานกลับให้ผู้ใช้ไปหาเองว่า
// ทำไมไม่ครบ ซึ่งเป็นเหตุผลเดียวกับที่เขาหันมาใช้ผู้ช่วยตั้งแต่แรก
//
// เพราะอย่างนั้น plan() ต้องคืน prerequisite **ครบทุกข้อในรอบเดียว** ห้ามล้มทีละอัน
// และ proposal ที่ยังมี prerequisite ค้างจะ commit ไม่ได้เด็ดขาด

import { createHash } from "node:crypto";

/** ค่าที่จะเปลี่ยน หนึ่งบรรทัดในการ์ดยืนยัน */
export interface FieldChange {
  readonly label: string;
  readonly before: string | null;
  readonly after: string;
}

/**
 * สิ่งที่ขาดจนทำคำสั่งต่อไม่ได้ — สามแบบที่ต้องปฏิบัติต่างกัน
 *
 *  choose  ของมีอยู่แล้วแต่รายการนี้ยังไม่ผูก (ร้านมีสถานีครัว แต่เมนู 12 ตัวยังไม่ผูก)
 *          → dialog ให้เลือก แสดงครบทุกรายการในจอเดียว
 *  create  ยังไม่มีของชนิดนั้นเลยในร้าน (ยังไม่มีสถานีครัวสักอัน)
 *          → เสนอสร้างให้ตรงนั้น ไม่ใช่ไล่ไปหน้าตั้งค่า
 *  blocked แพ็กเกจไม่รองรับ → แก้เองไม่ได้ บอกแล้วหยุด
 *          ตามกติกา "มี AI ได้ต่อเมื่อมีทุกฟีเจอร์แล้ว" แบบนี้ไม่ควรเกิดเลย
 *          เจอเมื่อไรแปลว่าแพ็กเกจถูกประกอบผิด → ผู้เรียกควรลง log เป็น anomaly
 */
export type Prerequisite =
  | {
      readonly kind: "choose";
      readonly need: string;
      readonly subjects: readonly { readonly id: string; readonly label: string }[];
      readonly options: readonly { readonly id: string; readonly label: string }[];
    }
  | { readonly kind: "create"; readonly need: string; readonly createTool: string; readonly reason: string }
  | { readonly kind: "blocked"; readonly need: string; readonly feature: string };

/** ผลของ plan() — ยังไม่มีอะไรถูกเขียน */
export interface ProposalDraft {
  readonly summary: string;
  readonly changes: readonly FieldChange[];
  readonly affectedCount: number;
  readonly warnings: readonly string[];
  readonly prerequisites: readonly Prerequisite[];
}

/** คำตอบของ prerequisite แบบ choose: subject id → option id */
export type PrerequisiteAnswers = Readonly<Record<string, string>>;

export interface ProposalRecord {
  readonly id: string;
  readonly organizationId: string;
  readonly storeId: string;
  readonly userId: string;
  readonly sessionId: string;
  readonly tool: string;
  /** args ที่ผ่าน Zod แล้วตอน plan — commit ใช้ชุดนี้ ไม่รับ args ใหม่จาก client */
  readonly args: unknown;
  /** ลายนิ้วมือของ draft ตอนเสนอ — ใช้จับว่าโลกเปลี่ยนไประหว่างที่ผู้ใช้ดูอยู่ */
  readonly draftFingerprint: string;
  readonly expiresAt: number;
}

export interface ProposalStore {
  readonly save: (record: ProposalRecord) => Promise<void>;
  readonly load: (id: string) => Promise<ProposalRecord | null>;
  /** ใช้ครั้งเดียว — กดยืนยันซ้ำต้องไม่ทำงานสองรอบ คืน false เมื่อถูกใช้ไปแล้ว */
  readonly consume: (id: string) => Promise<boolean>;
}

/** อายุของ proposal — สั้นพอที่ข้อมูลจะยังไม่เปลี่ยน ยาวพอให้คนอ่านการ์ดจบ */
export const PROPOSAL_TTL_MS = 5 * 60 * 1000;

/**
 * ลายนิ้วมือของสิ่งที่ผู้ใช้เห็นตอนกดยืนยัน
 *
 * commit จะ plan() ใหม่แล้วเทียบกับค่านี้ — ไม่ตรงแปลว่าระหว่างที่ผู้ใช้ดูการ์ดอยู่
 * มีคนอื่นแก้ข้อมูลไปแล้ว ต้องล้มแล้วเสนอใหม่ ห้ามเขียนทับเงียบ ๆ
 *
 * ไม่รวม warnings เข้าไปโดยตั้งใจ: คำเตือนอย่าง "เมนูนี้อยู่ในตะกร้าที่เปิดอยู่ 2 ใบ"
 * เปลี่ยนได้ทุกวินาทีตามงานหน้าร้าน ถ้านับด้วยจะไม่มีใครกดยืนยันสำเร็จเลยในร้านที่ยุ่ง
 * สิ่งที่ต้องไม่เปลี่ยนคือ "จะเปลี่ยนอะไรเป็นอะไร" และ "กระทบกี่รายการ"
 */
export function fingerprintDraft(draft: ProposalDraft): string {
  const stable = {
    summary: draft.summary,
    affectedCount: draft.affectedCount,
    changes: draft.changes.map((change) => [change.label, change.before, change.after]),
    prerequisites: draft.prerequisites.map((prerequisite) =>
      prerequisite.kind === "choose"
        ? [prerequisite.kind, prerequisite.need, prerequisite.subjects.map((subject) => subject.id).sort()]
        : [prerequisite.kind, prerequisite.need],
    ),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

/**
 * prerequisite ที่ยังเคลียร์ไม่ครบ — commit ต้องถูกปฏิเสธถ้ามีเหลือแม้ข้อเดียว
 *
 * `blocked` เคลียร์ด้วยคำตอบไม่ได้ตามนิยาม จึงนับว่าค้างเสมอ
 * `create` ต้องหายไปจาก draft รอบใหม่เอง (แปลว่าของถูกสร้างแล้วจริง) ไม่ใช่เคลียร์ด้วยการตอบ
 * `choose` เคลียร์เมื่อทุก subject มีคำตอบที่อยู่ในรายการตัวเลือกจริง
 */
export function unresolvedPrerequisites(
  prerequisites: readonly Prerequisite[],
  answers: PrerequisiteAnswers,
): readonly Prerequisite[] {
  return prerequisites.filter((prerequisite) => {
    if (prerequisite.kind !== "choose") return true;
    const valid = new Set(prerequisite.options.map((option) => option.id));
    return !prerequisite.subjects.every((subject) => valid.has(answers[subject.id] ?? ""));
  });
}

/** proposal นี้เป็นของ context ที่กำลังยืนยันจริงไหม — session อื่นยื่น id เข้ามาต้องไม่ผ่าน */
export function belongsToContext(
  record: ProposalRecord,
  context: { organizationId: string; storeId: string; userId: string; sessionId: string },
): boolean {
  return record.organizationId === context.organizationId
    && record.storeId === context.storeId
    && record.userId === context.userId
    && record.sessionId === context.sessionId;
}

/**
 * ผลลัพธ์นี้เป็น "การ์ดรอยืนยัน" ไม่ใช่ผลของการลงมือ
 *
 * แยกไว้เป็นฟังก์ชันเพราะทุกที่ที่เคยเขียน `result.ok ? result.data : ...` ต้องเลือกว่า
 * จะทำอย่างไรกับจังหวะแรก — ปล่อยผ่านเงียบ ๆ ไม่ได้ ไม่งั้นผู้ใช้จะเห็นว่า "สั่งแล้วเงียบ"
 */
export function isProposalResult(
  result: { ok: true; data: unknown } | { ok: true; kind: "proposal" } | { ok: false; code: string },
): boolean {
  return result.ok === true && "kind" in result;
}

/**
 * ดักข้อผิดพลาดของฝั่งเซิร์ฟเวอร์ "ทุกจุด" โดยอัตโนมัติ
 *
 * Next.js เรียก onRequestError ทุกครั้งที่มี error หลุดออกมาจาก server component,
 * route handler หรือ server action — จึงเป็นจุดเดียวที่ครอบคลุมได้จริงโดยไม่ต้อง
 * ไล่ใส่ try/catch ทีละไฟล์ ส่วน catch block ที่ "กลืน error ไว้เอง" (ไม่ throw ต่อ)
 * ต้องเรียก logActionError เองที่จุดนั้น เพราะ hook นี้มองไม่เห็น
 */
import type { Instrumentation } from "next";

export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  // hook นี้ทำงานได้ทั้ง node และ edge — ตัว logger ใช้ service client ที่รันได้เฉพาะ node
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { describeError, logSystemEvent } = await import("@/modules/system/event-log");
  const { message, errorCode } = describeError(error);

  await logSystemEvent({
    level: "error",
    // path บอกได้ตรงที่สุดว่าพังตรงไหนของแอป
    source: `http${request.path ? ` ${request.path.split("?")[0]}` : ""}`,
    action: `${context.routerKind}:${context.routeType}`,
    message,
    errorCode,
    context: {
      method: request.method,
      routePath: context.routePath,
      renderSource: context.renderSource ?? null,
      revalidateReason: context.revalidateReason ?? null,
      // stack ช่วยให้ AI ชี้ไฟล์ได้ แต่เก็บแค่ 3 บรรทัดแรกพอ (บรรทัดหลังเป็น framework)
      stack:
        error instanceof Error && typeof error.stack === "string"
          ? error.stack.split("\n").slice(0, 4).join("\n")
          : null,
    },
  });
};

export async function register(): Promise<void> {
  // ไม่มีอะไรต้องตั้งค่าตอนบูต — ไฟล์นี้มีไว้เพื่อ onRequestError เป็นหลัก
}

import { redirect } from "next/navigation";
import { getCurrentUser, getUserStores } from "@/modules/auth/session";
import { signOut } from "../(dashboard)/actions";
import { SubmitButton } from "@/shared/components/ui";
import { OpenStoreForm } from "./OpenStoreForm";

export const dynamic = "force-dynamic";

/** พนักงานที่เลยวันออกงานแล้ว (ไม่มีร้านที่ยังทำงานอยู่) — ไม่มีสิทธิ์ใช้งานระบบของร้านเดิม */
export default async function AccountInactivePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  // ยังมีร้านที่ใช้งานได้ (เช่นกลับเข้าทำงาน/ถูกแก้วันออกงาน หรือเปิดร้านเองแล้ว) = ไม่ต้องอยู่หน้านี้
  const { stores } = await getUserStores();
  if (stores.length > 0) redirect("/dashboard");

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--canvas)] px-4">
      <div className="panel w-full max-w-md space-y-4 p-6 text-center sm:p-8">
        <span className="badge badge-warning">ไม่มีสิทธิ์ใช้งาน</span>
        <h1 className="page-title">คุณไม่มีสิทธิ์ใช้งานระบบของร้านนี้แล้ว</h1>
        <p className="text-sm text-[var(--ink-2)]">
          บัญชี {user.email ?? ""} ถูกบันทึกว่าออกงานจากร้านแล้ว จึงเข้าใช้งาน ลงเวลา หรือรับแจ้งเตือนของร้านไม่ได้
          หากคิดว่าผิดพลาด ให้ติดต่อเจ้าของร้านเพื่อแก้ &quot;วันออกงาน&quot;
        </p>
        <OpenStoreForm />
        <form action={signOut}>
          <SubmitButton variant="secondary" className="w-full">
            ออกจากระบบ
          </SubmitButton>
        </form>
      </div>
    </main>
  );
}

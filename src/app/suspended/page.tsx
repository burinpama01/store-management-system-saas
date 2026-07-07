import { redirect } from "next/navigation";
import { getCurrentUser } from "@/modules/auth/session";
import { signOut } from "../(dashboard)/actions";
import { SubmitButton } from "@/shared/components/ui";

export const dynamic = "force-dynamic";

export default async function SuspendedPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <main className="grid min-h-screen place-items-center bg-[var(--canvas)] px-4">
      <div className="panel max-w-md space-y-4 p-8 text-center">
        <span className="badge badge-warning">บัญชีถูกระงับ</span>
        <h1 className="page-title">บัญชีองค์กรนี้ถูกระงับการใช้งาน</h1>
        <p className="text-sm text-[var(--ink-2)]">
          กิจการของคุณถูกระงับโดยผู้ดูแลแพลตฟอร์มชั่วคราว หากคิดว่าเป็นความผิดพลาด
          กรุณาติดต่อฝ่ายสนับสนุนเพื่อกู้คืนการเข้าใช้งาน
        </p>
        <a href="mailto:support@burindev.com" className="btn-primary inline-block">
          ติดต่อฝ่ายสนับสนุน
        </a>
        <form action={signOut}>
          <SubmitButton variant="secondary" className="w-full">
            ออกจากระบบ
          </SubmitButton>
        </form>
      </div>
    </main>
  );
}

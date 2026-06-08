import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { landingPathForCurrentUser } from "@/modules/auth/guards";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

export default async function AuthLayout({ children }: { children: ReactNode }) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (user) redirect(await landingPathForCurrentUser());
  return <>{children}</>;
}

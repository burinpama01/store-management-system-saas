"use server";

import { createSupabaseServerClient } from "@/server/integrations/supabase/server";
import { getUserStores } from "@/modules/auth/session";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export async function signOut() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");
  await supabase.auth.signOut();
  redirect("/login");
}

export async function setCurrentStore(storeId: string) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  // Validate user has membership in the requested store (enforced by RLS in getUserStores)
  const { stores } = await getUserStores();
  if (!stores.some((s) => s.id === storeId)) {
    return; // storeId not in user's accessible stores — silently reject
  }

  const cookieStore = await cookies();
  cookieStore.set("selected_store_id", storeId, {
    path: "/",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 30,
  });
  redirect("/");
}

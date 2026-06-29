import { randomBytes, createHash } from "node:crypto";
import { createSupabaseServiceClient } from "@/server/integrations/supabase/server";
import { mapError } from "@/shared/utils/error";

export interface ApiKeyView {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

/** SHA-256 hex of an API key plaintext — what we store and compare against. */
export function hashApiKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Generates a fresh key. The plaintext is returned to the caller exactly once. */
export function generateApiKey(): { plaintext: string; prefix: string; hash: string } {
  const plaintext = `sk_live_${randomBytes(24).toString("hex")}`;
  return { plaintext, prefix: plaintext.slice(0, 16), hash: hashApiKey(plaintext) };
}

function mapRow(row: {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  created_at: string;
  revoked_at: string | null;
}): ApiKeyView {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    scopes: row.scopes ?? [],
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

export async function listApiKeys(organizationId: string): Promise<ApiKeyView[]> {
  const supabase = await createSupabaseServiceClient();
  const { data } = await supabase
    .from("api_keys")
    .select("id, name, key_prefix, scopes, last_used_at, created_at, revoked_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false });
  return (data ?? []).map(mapRow);
}

export async function createApiKey(
  organizationId: string,
  name: string,
  createdBy: string,
): Promise<{ ok: true; plaintext: string; key: ApiKeyView } | { ok: false; error: string }> {
  const { plaintext, prefix, hash } = generateApiKey();
  const supabase = await createSupabaseServiceClient();
  const { data, error } = await supabase
    .from("api_keys")
    .insert({
      organization_id: organizationId,
      name: name.trim().slice(0, 80) || "API key",
      key_prefix: prefix,
      key_hash: hash,
      created_by: createdBy,
    })
    .select("id, name, key_prefix, scopes, last_used_at, created_at, revoked_at")
    .single();
  if (error || !data) return { ok: false, error: mapError(error).userMessage };
  return { ok: true, plaintext, key: mapRow(data) };
}

export async function revokeApiKey(
  organizationId: string,
  id: string,
): Promise<{ ok: boolean; error: string | null }> {
  const supabase = await createSupabaseServiceClient();
  const { error } = await supabase
    .from("api_keys")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", id)
    .eq("organization_id", organizationId)
    .is("revoked_at", null);
  if (error) return { ok: false, error: mapError(error).userMessage };
  return { ok: true, error: null };
}

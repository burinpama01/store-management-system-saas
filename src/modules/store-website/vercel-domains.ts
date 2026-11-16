/**
 * ต่อโดเมนของร้านเข้ากับโปรเจค Vercel (S4) — ใช้ VERCEL_TOKEN + VERCEL_PROJECT_ID (+ VERCEL_ORG_ID ถ้าเป็นทีม)
 * ไม่มี env = คืน { configured: false } ให้ผู้เรียกบันทึกเป็น “รอผู้ดูแลต่อโดเมน” (ไม่ fallback เงียบ — ผู้เรียกต้อง log)
 * https://vercel.com/docs/rest-api/reference/endpoints/projects/add-a-domain-to-a-project
 */

const API = "https://api.vercel.com";

type VercelEnv = { token: string; projectId: string; teamId: string | null };

function env(): VercelEnv | null {
  const token = process.env.VERCEL_TOKEN?.trim();
  const projectId = process.env.VERCEL_PROJECT_ID?.trim();
  if (!token || !projectId) return null;
  const org = process.env.VERCEL_ORG_ID?.trim() ?? "";
  return { token, projectId, teamId: org.startsWith("team_") ? org : null };
}

export function isVercelDomainsConfigured(): boolean {
  return env() !== null;
}

function url(e: VercelEnv, path: string): string {
  return `${API}${path}${e.teamId ? `${path.includes("?") ? "&" : "?"}teamId=${encodeURIComponent(e.teamId)}` : ""}`;
}

async function call(e: VercelEnv, method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(url(e, path), {
    method,
    headers: { Authorization: `Bearer ${e.token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: res.ok, status: res.status, json };
}

function errorMessage(json: Record<string, unknown>, fallback: string): string {
  const err = json.error as { code?: string; message?: string } | undefined;
  return err?.message ? `${err.code ?? "error"}: ${err.message}`.slice(0, 280) : fallback;
}

export type DomainVerification = { type: string; domain: string; value: string };

export type DomainCheck =
  | { configured: false }
  | { configured: true; error: string }
  | { configured: true; error: null; verified: boolean; misconfigured: boolean; verification: DomainVerification[] };

/** เพิ่มโดเมนเข้าโปรเจค (ซ้ำ = ถือว่าสำเร็จ) */
export async function addProjectDomain(domain: string): Promise<{ configured: false } | { configured: true; error: string | null }> {
  const e = env();
  if (!e) return { configured: false };
  const res = await call(e, "POST", `/v10/projects/${encodeURIComponent(e.projectId)}/domains`, { name: domain });
  const code = (res.json.error as { code?: string } | undefined)?.code;
  if (res.ok || code === "domain_already_in_use_by_project" || code === "domain_already_exists") return { configured: true, error: null };
  return { configured: true, error: errorMessage(res.json, `เพิ่มโดเมนไม่สำเร็จ (${res.status})`) };
}

/** ตรวจว่าโดเมนยืนยันแล้ว + DNS ชี้มาถูก */
export async function checkProjectDomain(domain: string): Promise<DomainCheck> {
  const e = env();
  if (!e) return { configured: false };
  const project = await call(e, "GET", `/v9/projects/${encodeURIComponent(e.projectId)}/domains/${encodeURIComponent(domain)}`);
  if (!project.ok) return { configured: true, error: errorMessage(project.json, `ไม่พบโดเมนในโปรเจค (${project.status})`) };
  let verified = Boolean(project.json.verified);
  if (!verified) {
    const verify = await call(e, "POST", `/v9/projects/${encodeURIComponent(e.projectId)}/domains/${encodeURIComponent(domain)}/verify`);
    verified = verify.ok && Boolean(verify.json.verified);
  }
  const config = await call(e, "GET", `/v6/domains/${encodeURIComponent(domain)}/config`);
  const misconfigured = config.ok ? Boolean(config.json.misconfigured) : true;
  const verification = Array.isArray(project.json.verification)
    ? (project.json.verification as Array<Record<string, unknown>>).map((v) => ({
        type: String(v.type ?? ""),
        domain: String(v.domain ?? ""),
        value: String(v.value ?? ""),
      }))
    : [];
  return { configured: true, error: null, verified, misconfigured, verification };
}

export async function removeProjectDomain(domain: string): Promise<{ configured: false } | { configured: true; error: string | null }> {
  const e = env();
  if (!e) return { configured: false };
  const res = await call(e, "DELETE", `/v9/projects/${encodeURIComponent(e.projectId)}/domains/${encodeURIComponent(domain)}`);
  if (res.ok || res.status === 404) return { configured: true, error: null };
  return { configured: true, error: errorMessage(res.json, `ลบโดเมนไม่สำเร็จ (${res.status})`) };
}

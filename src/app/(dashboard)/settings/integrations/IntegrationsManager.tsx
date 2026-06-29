"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/shared/components/ui";
import type { ApiKeyView } from "@/modules/api-keys/repository";
import { createApiKeyAction, revokeApiKeyAction } from "./actions";

export function IntegrationsManager({ keys }: { keys: ApiKeyView[] }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [newKey, setNewKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleCreate() {
    setError(null);
    setNewKey(null);
    startTransition(async () => {
      const res = await createApiKeyAction(name);
      if (res.error) { setError(res.error); return; }
      setNewKey(res.plaintext);
      setName("");
      router.refresh();
    });
  }

  function handleRevoke(id: string) {
    setError(null);
    startTransition(async () => {
      const res = await revokeApiKeyAction(id);
      if (res.error) { setError(res.error); return; }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="panel p-4">
        <p className="text-sm font-bold text-[var(--color-text-primary)]">REST API (v1)</p>
        <p className="mt-1 text-sm text-[var(--color-text-muted)]">
          ดึงข้อมูลสินค้า ออร์เดอร์ สต็อก และลูกค้าแบบอ่านอย่างเดียว ใส่คีย์ในเฮดเดอร์{" "}
          <code className="rounded bg-[var(--color-surface-muted)] px-1">Authorization: Bearer &lt;key&gt;</code>{" "}
          เรียก <code className="rounded bg-[var(--color-surface-muted)] px-1">/api/v1/products</code>,{" "}
          <code className="rounded bg-[var(--color-surface-muted)] px-1">/orders</code>,{" "}
          <code className="rounded bg-[var(--color-surface-muted)] px-1">/inventory</code>,{" "}
          <code className="rounded bg-[var(--color-surface-muted)] px-1">/customers</code>
        </p>
      </div>

      <div className="panel p-4 space-y-3">
        <p className="text-sm font-bold text-[var(--color-text-primary)]">สร้าง API key ใหม่</p>
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="field-label">ชื่อ (เพื่อจดจำ)</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="เช่น ระบบบัญชี"
              maxLength={80}
              className="px-3 py-1.5 text-sm border border-[var(--border)] rounded-[var(--radius-md)]"
            />
          </div>
          <Button variant="primary" onClick={handleCreate} loading={isPending} disabled={!name.trim()}>
            สร้างคีย์
          </Button>
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        {newKey && (
          <div className="rounded-[var(--radius-md)] border border-amber-300 bg-amber-50 p-3">
            <p className="text-xs font-bold text-amber-800">
              คัดลอกคีย์นี้ตอนนี้ — จะแสดงครั้งเดียวเท่านั้น
            </p>
            <code className="mt-1 block break-all text-sm text-amber-900">{newKey}</code>
          </div>
        )}
      </div>

      <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
        {keys.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-gray-400">ยังไม่มี API key</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface-muted)] text-xs font-bold text-[var(--color-text-secondary)]">
              <tr>
                <th className="px-3 py-2 text-left">ชื่อ</th>
                <th className="px-3 py-2 text-left">คีย์</th>
                <th className="px-3 py-2 text-left">ใช้ล่าสุด</th>
                <th className="px-3 py-2 text-right">จัดการ</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--color-border)]">
              {keys.map((k) => (
                <tr key={k.id} className={k.revokedAt ? "opacity-50" : ""}>
                  <td className="px-3 py-2">{k.name}</td>
                  <td className="px-3 py-2"><code>{k.keyPrefix}…</code></td>
                  <td className="px-3 py-2 text-[var(--color-text-muted)]">
                    {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString("th-TH") : "ยังไม่เคยใช้"}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {k.revokedAt ? (
                      <span className="text-xs text-gray-400">เพิกถอนแล้ว</span>
                    ) : (
                      <button
                        onClick={() => handleRevoke(k.id)}
                        className="text-xs text-red-600 hover:underline"
                        disabled={isPending}
                      >
                        เพิกถอน
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

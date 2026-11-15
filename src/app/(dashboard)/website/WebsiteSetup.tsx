"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { normalizeSlug, validateSlug } from "@/modules/store-website/schema";
import { BUSINESS_LABELS, STYLE_LABELS, type WebsiteTemplate } from "@/modules/store-website/templates";
import { createWebsiteAction } from "./actions";

/** ขั้นแรก: ตั้งลิงก์ร้าน + เลือกเทมเพลต */
export function WebsiteSetup({ templates, defaultSlug, siteBase }: { templates: WebsiteTemplate[]; defaultSlug: string; siteBase: string }) {
  const router = useRouter();
  const [slug, setSlug] = useState(defaultSlug);
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const cleanSlug = normalizeSlug(slug);
  const slugError = cleanSlug ? validateSlug(cleanSlug) : "ตั้งลิงก์ร้าน";

  function create() {
    if (slugError) {
      setError(slugError);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await createWebsiteAction(cleanSlug, templateId);
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="panel space-y-2 p-4">
        <label className="block text-sm font-semibold text-[var(--color-text-primary)]" htmlFor="website-slug">ลิงก์เว็บไซต์ร้าน</label>
        <div className="flex flex-wrap items-center gap-1 text-sm">
          <span className="text-[var(--color-text-muted)]">{siteBase}/s/</span>
          <input id="website-slug" className="input w-56" style={{ fontSize: 16 }} value={slug} maxLength={40}
            onChange={(e) => setSlug(e.target.value)} placeholder="ชื่อร้าน-ภาษาอังกฤษ" />
        </div>
        <p className={`text-xs ${slugError ? "text-amber-700" : "text-[var(--color-text-muted)]"}`}>
          {slugError ?? `ลิงก์จะเป็น ${siteBase}/s/${cleanSlug}`}
        </p>
      </div>

      <div className="panel p-4">
        <p className="mb-3 text-sm font-semibold text-[var(--color-text-primary)]">เลือกเทมเพลต (เปลี่ยนทีหลังได้ เนื้อหาไม่หาย)</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => (
            <button
              key={template.id}
              type="button"
              onClick={() => setTemplateId(template.id)}
              className={`overflow-hidden rounded-xl border text-left ${templateId === template.id ? "border-[var(--color-brand)] ring-2 ring-[var(--color-brand)]" : "border-[var(--color-border)]"}`}
            >
              <div className="h-24" style={{ background: `linear-gradient(135deg, ${template.theme.primary}, ${template.theme.accent})` }}>
                <div className="flex h-full items-end p-3" style={{ color: "#fff", fontFamily: template.theme.font === "serif" ? "Georgia, serif" : undefined }}>
                  <span className="text-lg font-bold">{template.name}</span>
                </div>
              </div>
              <div className="p-3 text-sm" style={{ background: template.theme.background, color: template.theme.text }}>
                <span className="mr-1 rounded-full bg-black/10 px-2 py-0.5 text-xs">{BUSINESS_LABELS[template.business]}</span>
                <span className="rounded-full bg-black/10 px-2 py-0.5 text-xs">{STYLE_LABELS[template.style]}</span>
                <p className="mt-1 text-xs opacity-80">{template.description}</p>
              </div>
            </button>
          ))}
        </div>
      </div>

      {error && <p className="alert-danger text-sm" role="alert">{error}</p>}
      <button type="button" className="btn-primary" disabled={pending} onClick={create}>
        {pending ? "กำลังสร้าง…" : "สร้างเว็บไซต์ร้าน"}
      </button>
      <p className="text-xs text-[var(--color-text-muted)]">สร้างแล้วเว็บยังไม่เปิดให้ลูกค้าเห็น จนกว่าจะกดเผยแพร่และเปิดเว็บ</p>
    </div>
  );
}

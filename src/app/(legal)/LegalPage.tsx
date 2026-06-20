import Link from "next/link";
import { GlassPanel, MarketingFooter, MarketingHeader } from "@/shared/components/marketing/MarketingShell";

type LegalSection = {
  title: string;
  body: string[];
};

type LegalPageProps = {
  title: string;
  kicker: string;
  updatedAt: string;
  sections: LegalSection[];
  relatedHref: string;
  relatedLabel: string;
};

export function LegalPage({
  title,
  kicker,
  updatedAt,
  sections,
  relatedHref,
  relatedLabel,
}: Readonly<LegalPageProps>) {
  return (
    <main className="marketing-page">
      <MarketingHeader />

      <section className="mx-auto grid w-full max-w-4xl gap-5 py-10 sm:py-14">
        <GlassPanel className="p-6 sm:p-8">
          <p className="text-xs font-black uppercase tracking-wide text-[var(--tenant-primary-strong)]">
            StoreOS Legal
          </p>
          <h1 className="mt-3 text-3xl font-black text-[var(--ink)] sm:text-4xl">{title}</h1>
          <p className="mt-3 text-base text-[var(--ink-2)]">{kicker}</p>
          <p className="mt-4 text-sm font-bold text-[var(--muted)]">อัปเดตล่าสุด: {updatedAt}</p>
        </GlassPanel>

        {sections.map((section) => (
          <GlassPanel key={section.title} className="p-6 sm:p-7">
            <h2 className="text-xl font-black text-[var(--ink)]">{section.title}</h2>
            <div className="mt-3 space-y-3 text-sm leading-7 text-[var(--ink-2)]">
              {section.body.map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
          </GlassPanel>
        ))}

        <GlassPanel className="flex flex-col gap-3 p-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-lg font-black text-[var(--ink)]">เอกสารที่เกี่ยวข้อง</h2>
            <p className="mt-1 text-sm text-[var(--ink-2)]">
              ใช้ URL ของหน้านี้กรอกใน LINE Official Account Manager ได้โดยตรง
            </p>
          </div>
          <Link href={relatedHref} className="btn-secondary text-center">
            {relatedLabel}
          </Link>
        </GlassPanel>
      </section>

      <MarketingFooter />
    </main>
  );
}

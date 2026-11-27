"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { isActiveInvoice, SALES_DOCUMENT_TITLES, type SalesDocument } from "@/modules/tax/documents";
import type { OrderForInvoice } from "@/modules/tax/documents-repository";
import type { TaxParty } from "@/modules/tax/types";
import { branchLabel } from "@/shared/utils/thai-tax-id";
import {
  cancelDocumentAction,
  findOrderForInvoiceAction,
  issueCreditNoteAction,
  issueTaxInvoiceAction,
  saveBuyerAction,
  searchBuyersAction,
} from "./actions";

const inputClass = "min-h-11 w-full rounded-lg border border-[var(--border)] bg-white px-3 text-[16px] text-[var(--ink)]";

function money(value: number) {
  return new Intl.NumberFormat("th-TH", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

const EMPTY_BUYER = { partyType: "company" as "company" | "individual", name: "", taxId: "", branchCode: "", address: "", email: "", phone: "" };

type Prompt = { kind: "credit" | "cancel"; doc: SalesDocument; reason: string } | null;

export function TaxDocumentsManager({ documents, canIssue, canVoid }: { documents: SalesDocument[]; canIssue: boolean; canVoid: boolean }) {
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string; href?: string } | null>(null);
  const [isPending, startTransition] = useTransition();
  const [orderNumber, setOrderNumber] = useState("");
  const [order, setOrder] = useState<OrderForInvoice | null>(null);
  const [query, setQuery] = useState("");
  const [buyers, setBuyers] = useState<TaxParty[]>([]);
  const [buyer, setBuyer] = useState<TaxParty | null>(null);
  const [newBuyer, setNewBuyer] = useState<typeof EMPTY_BUYER | null>(null);
  const [prompt, setPrompt] = useState<Prompt>(null);

  function reset() {
    setOrder(null);
    setOrderNumber("");
    setBuyer(null);
    setBuyers([]);
    setQuery("");
    setNewBuyer(null);
  }

  function findOrder() {
    setMessage(null);
    startTransition(async () => {
      const result = await findOrderForInvoiceAction(orderNumber);
      if (result.error || !result.data) {
        setOrder(null);
        setMessage({ tone: "error", text: result.error ?? "ไม่พบบิล" });
        return;
      }
      setOrder(result.data);
      if (result.data.status !== "paid") setMessage({ tone: "error", text: "บิลนี้ยังไม่ได้ชำระ — ออกใบกำกับได้เฉพาะบิลที่ชำระแล้ว" });
    });
  }

  function searchBuyers() {
    startTransition(async () => {
      const result = await searchBuyersAction(query);
      setBuyers(result.data);
      if (result.error) setMessage({ tone: "error", text: result.error });
    });
  }

  function saveNewBuyer() {
    if (!newBuyer) return;
    startTransition(async () => {
      const input = {
        partyType: newBuyer.partyType,
        name: newBuyer.name,
        taxId: newBuyer.taxId || null,
        branchCode: newBuyer.branchCode || null,
        address: newBuyer.address || null,
        email: newBuyer.email || null,
        phone: newBuyer.phone || null,
        customerId: null,
        isActive: true,
      };
      const result = await saveBuyerAction(input);
      if (result.error || !result.data) {
        setMessage({ tone: "error", text: result.error ?? "บันทึกผู้ซื้อไม่สำเร็จ" });
        return;
      }
      setBuyer({ id: result.data.id, ...input, branchCode: input.branchCode ?? (input.taxId && input.partyType === "company" ? "00000" : null) });
      setNewBuyer(null);
    });
  }

  function issue() {
    if (!order || !buyer) return;
    startTransition(async () => {
      const result = await issueTaxInvoiceAction(order.id, buyer.id);
      if (result.error || !result.data) {
        setMessage({ tone: "error", text: result.error ?? "ออกใบกำกับภาษีไม่สำเร็จ" });
        return;
      }
      setMessage({ tone: "ok", text: `ออกใบกำกับภาษีเลขที่ ${result.data.docNo} แล้ว`, href: `/tax-document/${result.data.id}` });
      reset();
    });
  }

  function submitPrompt() {
    if (!prompt) return;
    const { kind, doc, reason } = prompt;
    startTransition(async () => {
      if (kind === "credit") {
        const result = await issueCreditNoteAction(doc.id, reason);
        if (result.error || !result.data) {
          setMessage({ tone: "error", text: result.error ?? "ออกใบลดหนี้ไม่สำเร็จ" });
          return;
        }
        setMessage({ tone: "ok", text: `ออกใบลดหนี้เลขที่ ${result.data.docNo} แล้ว — บิล ${doc.orderNumber ?? ""} คืนเงิน/ยกเลิกในระบบขายได้แล้ว`, href: `/tax-document/${result.data.id}` });
      } else {
        const result = await cancelDocumentAction(doc.id, reason);
        if (result.error) {
          setMessage({ tone: "error", text: result.error });
          return;
        }
        setMessage({ tone: "ok", text: `ยกเลิกเอกสาร ${doc.docNo} แล้ว (เลขที่นี้จะไม่ถูกใช้ซ้ำ)` });
      }
      setPrompt(null);
    });
  }

  return (
    <div className="space-y-5">
      {message && (
        <p role="status" className={`rounded-lg px-3 py-2 text-sm ${message.tone === "ok" ? "bg-green-50 text-green-800" : "bg-red-50 text-red-700"}`}>
          {message.text}{" "}
          {message.href && (
            <Link href={message.href} target="_blank" className="font-semibold underline">เปิดเพื่อพิมพ์</Link>
          )}
        </p>
      )}

      {canIssue && (
        <div className="space-y-4 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
          <h2 className="text-base font-semibold text-[var(--ink)]">ออกใบเสร็จรับเงิน/ใบกำกับภาษีจากบิล</h2>

          <div className="flex flex-wrap items-end gap-2">
            <label className="block min-w-48 flex-1 text-sm">
              <span className="text-[var(--muted)]">1. เลขบิล (ตามใบเสร็จ)</span>
              <input className={inputClass} value={orderNumber} maxLength={40} onChange={(e) => setOrderNumber(e.target.value)} onKeyDown={(e) => e.key === "Enter" && findOrder()} />
            </label>
            <button type="button" className="btn-secondary min-h-11" disabled={isPending || !orderNumber.trim()} onClick={findOrder}>ค้นบิล</button>
          </div>

          {order && (
            <p className="rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-sm text-[var(--ink)]">
              บิล {order.orderNumber} · {order.itemCount} รายการ · ยอด ฿{money(order.total)} ·{" "}
              {order.status === "paid" ? `ชำระ ${order.paidAt ? new Date(order.paidAt).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" }) : ""}` : `สถานะ ${order.status}`}
            </p>
          )}

          {order?.status === "paid" && (
            <div className="space-y-3">
              <p className="text-sm text-[var(--muted)]">2. ผู้ซื้อ (ชื่อและที่อยู่จะพิมพ์บนใบกำกับ)</p>
              {buyer ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] p-3 text-sm">
                  <span>
                    <b>{buyer.name}</b>
                    {buyer.taxId && ` · ${buyer.taxId} ${branchLabel(buyer.branchCode)}`}
                    <br />
                    <span className="text-[var(--muted)]">{buyer.address}</span>
                  </span>
                  <button type="button" className="btn-secondary min-h-10 text-sm" onClick={() => setBuyer(null)}>เปลี่ยน</button>
                </div>
              ) : newBuyer ? (
                <div className="grid gap-3 rounded-lg border border-[var(--border)] p-3 sm:grid-cols-2">
                  <label className="block text-sm">
                    <span className="text-[var(--muted)]">ประเภท</span>
                    <select className={inputClass} value={newBuyer.partyType} onChange={(e) => setNewBuyer({ ...newBuyer, partyType: e.target.value as "company" | "individual" })}>
                      <option value="company">นิติบุคคล (บริษัท/ห้างฯ)</option>
                      <option value="individual">บุคคลธรรมดา</option>
                    </select>
                  </label>
                  <label className="block text-sm">
                    <span className="text-[var(--muted)]">ชื่อ *</span>
                    <input className={inputClass} maxLength={200} value={newBuyer.name} onChange={(e) => setNewBuyer({ ...newBuyer, name: e.target.value })} />
                  </label>
                  <label className="block text-sm">
                    <span className="text-[var(--muted)]">เลขประจำตัวผู้เสียภาษี{newBuyer.partyType === "company" ? " *" : ""}</span>
                    <input className={inputClass} inputMode="numeric" maxLength={17} value={newBuyer.taxId} onChange={(e) => setNewBuyer({ ...newBuyer, taxId: e.target.value })} />
                  </label>
                  <label className="block text-sm">
                    <span className="text-[var(--muted)]">เลขสาขา (สำนักงานใหญ่ = 00000)</span>
                    <input className={inputClass} inputMode="numeric" maxLength={5} value={newBuyer.branchCode} onChange={(e) => setNewBuyer({ ...newBuyer, branchCode: e.target.value })} />
                  </label>
                  <label className="block text-sm sm:col-span-2">
                    <span className="text-[var(--muted)]">ที่อยู่ *</span>
                    <textarea className={`${inputClass} min-h-20 py-2`} maxLength={500} value={newBuyer.address} onChange={(e) => setNewBuyer({ ...newBuyer, address: e.target.value })} />
                  </label>
                  <div className="flex gap-2 sm:col-span-2">
                    <button type="button" className="btn-primary min-h-11" disabled={isPending} onClick={saveNewBuyer}>บันทึกผู้ซื้อ</button>
                    <button type="button" className="btn-secondary min-h-11" onClick={() => setNewBuyer(null)}>ยกเลิก</button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-2">
                    <input className={`${inputClass} min-w-48 flex-1`} placeholder="ค้นชื่อหรือเลขผู้เสียภาษี" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && searchBuyers()} />
                    <button type="button" className="btn-secondary min-h-11" disabled={isPending} onClick={searchBuyers}>ค้น</button>
                    <button type="button" className="btn-secondary min-h-11" onClick={() => setNewBuyer({ ...EMPTY_BUYER })}>+ ผู้ซื้อใหม่</button>
                  </div>
                  {buyers.length > 0 && (
                    <ul className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)] text-sm">
                      {buyers.map((b) => (
                        <li key={b.id}>
                          <button type="button" className="w-full p-3 text-left hover:bg-[var(--surface-muted)]" onClick={() => setBuyer(b)}>
                            <b>{b.name}</b>{b.taxId && ` · ${b.taxId} ${branchLabel(b.branchCode)}`}
                            <br />
                            <span className="text-[var(--muted)]">{b.address ?? "ไม่มีที่อยู่ — แก้ก่อนใช้"}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}

              {buyer && (
                <button type="button" className="btn-primary min-h-11" disabled={isPending} onClick={issue}>
                  3. ออกใบเสร็จรับเงิน/ใบกำกับภาษี ฿{money(order.total)}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {prompt && (
        <div className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-4">
          <h2 className="text-base font-semibold text-red-900">
            {prompt.kind === "credit" ? `ออกใบลดหนี้เต็มจำนวนสำหรับ ${prompt.doc.docNo}` : `ยกเลิกเอกสาร ${prompt.doc.docNo}`}
          </h2>
          <p className="text-sm text-red-800">
            {prompt.kind === "credit"
              ? "ใช้เมื่อคืนเงินหรือยกเลิกการขายหลังออกใบกำกับแล้ว — ลดหนี้เต็มยอด จากนั้นจึงคืนเงิน/ยกเลิกบิลในระบบขาย"
              : "ใช้เมื่อออกเอกสารผิด (เช่น ชื่อผู้ซื้อผิด) แล้วต้องออกใหม่ — เลขที่เดิมจะถูกเก็บไว้เป็นยกเลิก"}
          </p>
          <input className={inputClass} maxLength={500} placeholder="เหตุผล (บังคับ)" value={prompt.reason} onChange={(e) => setPrompt({ ...prompt, reason: e.target.value })} />
          <div className="flex gap-2">
            <button type="button" className="btn-primary min-h-11" disabled={isPending || !prompt.reason.trim()} onClick={submitPrompt}>ยืนยัน</button>
            <button type="button" className="btn-secondary min-h-11" onClick={() => setPrompt(null)}>ปิด</button>
          </div>
        </div>
      )}

      <section className="space-y-2">
        <h2 className="text-base font-semibold text-[var(--ink)]">เอกสารที่ออกแล้ว <span className="text-sm font-normal text-[var(--muted)]">(แสดง 150 รายการล่าสุด)</span></h2>
        {documents.length === 0 ? (
          <p className="rounded-xl border border-dashed border-[var(--border)] p-6 text-center text-sm text-[var(--muted)]">ยังไม่มีเอกสาร</p>
        ) : (
          <ul className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface)]">
            {documents.map((doc) => {
              const active = isActiveInvoice(doc, documents);
              return (
                <li key={doc.id} className={`flex flex-wrap items-center justify-between gap-3 p-3 ${doc.status === "cancelled" ? "opacity-60" : ""}`}>
                  <div className="min-w-0 text-sm">
                    <p className="font-semibold text-[var(--ink)]">
                      {doc.docNo} · {SALES_DOCUMENT_TITLES[doc.docType]}
                      {doc.status === "cancelled" && <span className="ml-2 rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-800">ยกเลิก</span>}
                    </p>
                    <p className="text-[var(--muted)]">
                      {doc.buyer.name} · ฿{money(doc.totalAmount)} · วันที่ {doc.issueDate}
                      {doc.orderNumber && ` · บิล ${doc.orderNumber}`}
                      {doc.cancelReason && ` · เหตุผลยกเลิก: ${doc.cancelReason}`}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link href={`/tax-document/${doc.id}`} target="_blank" className="btn-secondary inline-flex min-h-10 items-center text-sm">พิมพ์</Link>
                    {canVoid && active && (
                      <button type="button" className="btn-secondary min-h-10 text-sm" disabled={isPending} onClick={() => setPrompt({ kind: "credit", doc, reason: "" })}>ใบลดหนี้</button>
                    )}
                    {canVoid && doc.status === "issued" && (doc.docType === "credit_note" || active) && (
                      <button type="button" className="btn-secondary min-h-10 text-sm" disabled={isPending} onClick={() => setPrompt({ kind: "cancel", doc, reason: "" })}>ยกเลิก</button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

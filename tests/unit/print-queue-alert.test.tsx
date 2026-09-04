// @vitest-environment jsdom
// v3 — แถบเตือน "งานพิมพ์ที่ต้องตรวจสอบ" บนหน้าขาย
// ⚠️ ต้องมี header jsdom ทุกครั้ง — static-import @testing-library/* บน node env คือ hang จน timeout
//
// กติกาที่ต้องคง: ระบบไม่พิมพ์ซ้ำให้เอง คนที่เห็นกระดาษเป็นผู้ตัดสิน และแถบต้องไม่โผล่
// มารบกวนหน้าขายเมื่อไม่มีงานค้าง
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../setup/react";

const resolveAction = vi.hoisted(() => vi.fn());
vi.mock("@/app/pos/actions", () => ({
  resolveUnknownPrintJobFromPosAction: resolveAction,
}));

import { PrintQueueAlert } from "@/modules/printing/PrintQueueAlert";

const job = (id: string, kind: "receipt" | "station_ticket" | null = "receipt") => ({
  id,
  jobKind: kind,
  attempts: 1,
  createdAt: "2026-09-04T02:00:00.000Z",
});

function mockQueue(jobs: ReturnType<typeof job>[]) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ ok: true, pendingJobs: 0, unknownJobs: jobs.length, unknownJobList: jobs }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resolveAction.mockReset();
  resolveAction.mockResolvedValue({ error: null, status: "printed" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PrintQueueAlert", () => {
  it("ไม่แสดงอะไรเลยเมื่อไม่มีงานค้าง (ไม่รบกวนหน้าขาย)", async () => {
    mockQueue([]);
    const { container } = render(<PrintQueueAlert />);
    await act(async () => {});
    expect(container.firstChild).toBeNull();
  });

  it("แสดงงานที่ไม่ทราบผลพร้อมสองทางเลือกที่คนต้องตัดสิน", async () => {
    mockQueue([job("job-1"), job("job-2", "station_ticket")]);
    render(<PrintQueueAlert />);

    await waitFor(() => expect(screen.getByText(/งานพิมพ์ที่ต้องตรวจสอบ \(2\)/)).toBeTruthy());
    expect(screen.getByText("ใบเสร็จ")).toBeTruthy();
    expect(screen.getByText("ตั๋วครัว")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "ออกแล้ว" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "พิมพ์ใหม่" })).toHaveLength(2);
    // ต้องบอกให้ไปดูกระดาษก่อน ไม่ใช่ให้กดมั่ว
    expect(screen.getByText(/ดูที่กระดาษก่อน/)).toBeTruthy();
  });

  it("กด 'ออกแล้ว' = ปิดงานนั้น ไม่สั่งพิมพ์ซ้ำ", async () => {
    mockQueue([job("job-1")]);
    render(<PrintQueueAlert />);
    await waitFor(() => expect(screen.getByText(/งานพิมพ์ที่ต้องตรวจสอบ/)).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ออกแล้ว" }));
    });

    expect(resolveAction).toHaveBeenCalledWith({ jobId: "job-1", resolution: "printed_confirmed" });
  });

  it("กด 'พิมพ์ใหม่' = ส่งกลับเข้าคิวเป็นการตัดสินของคน", async () => {
    mockQueue([job("job-1")]);
    render(<PrintQueueAlert />);
    await waitFor(() => expect(screen.getByText(/งานพิมพ์ที่ต้องตรวจสอบ/)).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "พิมพ์ใหม่" }));
    });

    expect(resolveAction).toHaveBeenCalledWith({ jobId: "job-1", resolution: "retried" });
  });

  it("จัดการไม่สำเร็จต้องบอกเหตุผล ไม่ใช่หายไปเงียบ ๆ", async () => {
    mockQueue([job("job-1")]);
    resolveAction.mockResolvedValue({ error: "งานนี้ถูกจัดการไปแล้ว" });
    render(<PrintQueueAlert />);
    await waitFor(() => expect(screen.getByText(/งานพิมพ์ที่ต้องตรวจสอบ/)).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ออกแล้ว" }));
    });

    expect(screen.getByText("งานนี้ถูกจัดการไปแล้ว")).toBeTruthy();
  });

  it("กดซ่อนแล้วแถบหายไป (แต่ไม่ได้แก้สถานะงาน)", async () => {
    mockQueue([job("job-1")]);
    const { container } = render(<PrintQueueAlert />);
    await waitFor(() => expect(screen.getByText(/งานพิมพ์ที่ต้องตรวจสอบ/)).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "ซ่อนแถบนี้ไว้ก่อน" }));
    });

    expect(container.firstChild).toBeNull();
    expect(resolveAction).not.toHaveBeenCalled();
  });

  it("เรียก endpoint ของแคชเชียร์ ไม่ใช่ของหน้าตั้งค่า", async () => {
    const fetchMock = mockQueue([]);
    render(<PrintQueueAlert />);
    await act(async () => {});
    expect(fetchMock).toHaveBeenCalledWith("/api/print/queue-health", { cache: "no-store" });
  });
});

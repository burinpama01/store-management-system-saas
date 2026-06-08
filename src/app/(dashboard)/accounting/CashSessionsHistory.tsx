import type { CashSession } from "@/modules/cashflow/types";

function fmt(amount: number | undefined, currency: string): string {
  return new Intl.NumberFormat("th-TH", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount ?? 0);
}

function dt(value: string): string {
  return new Date(value).toLocaleString("th-TH", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function CashSessionsHistory({
  sessions,
  currency,
}: {
  sessions: CashSession[];
  currency: string;
}) {
  return (
    <div className="bg-white rounded-lg border border-gray-200 overflow-hidden">
      <div className="px-4 py-3 border-b border-gray-100">
        <h2 className="text-sm font-bold text-gray-900">รอบเงินสด (เปิด/ปิดร้าน)</h2>
        <p className="text-xs text-gray-500">กระทบยอดเงินสดในลิ้นชักกับยอดขาย POS</p>
      </div>
      {sessions.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-gray-400">ยังไม่มีรอบเงินสด</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b border-gray-100">
                <th className="px-4 py-2 font-medium">เปิดรอบ</th>
                <th className="px-4 py-2 font-medium">สถานะ</th>
                <th className="px-4 py-2 font-medium text-right">เงินเปิด</th>
                <th className="px-4 py-2 font-medium text-right">ขายเงินสด</th>
                <th className="px-4 py-2 font-medium text-right">ควรมี</th>
                <th className="px-4 py-2 font-medium text-right">นับได้</th>
                <th className="px-4 py-2 font-medium text-right">ส่วนต่าง</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => {
                const variance = s.variance ?? 0;
                return (
                  <tr key={s.id} className="border-b border-gray-50 last:border-0">
                    <td className="px-4 py-2 text-gray-700">{dt(s.openedAt)}</td>
                    <td className="px-4 py-2">
                      {s.status === "open" ? (
                        <span className="inline-flex items-center gap-1 text-green-600 text-xs font-medium">
                          🟢 เปิดอยู่
                        </span>
                      ) : (
                        <span className="text-gray-500 text-xs">
                          ปิด {s.closedAt ? dt(s.closedAt) : ""}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-700">{fmt(s.openingFloat, currency)}</td>
                    <td className="px-4 py-2 text-right text-gray-700">
                      {s.status === "closed" ? fmt(s.cashSales, currency) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-700">
                      {s.status === "closed" ? fmt(s.expectedCash, currency) : "—"}
                    </td>
                    <td className="px-4 py-2 text-right text-gray-700">
                      {s.status === "closed" ? fmt(s.closingCount, currency) : "—"}
                    </td>
                    <td
                      className={`px-4 py-2 text-right font-semibold ${
                        s.status !== "closed"
                          ? "text-gray-400"
                          : variance === 0
                            ? "text-green-600"
                            : variance > 0
                              ? "text-blue-600"
                              : "text-red-600"
                      }`}
                    >
                      {s.status === "closed" ? fmt(variance, currency) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

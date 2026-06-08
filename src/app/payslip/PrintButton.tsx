"use client";

export function PrintButton() {
  return (
    <button
      onClick={() => window.print()}
      className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-white print:hidden"
    >
      พิมพ์ / บันทึกเป็น PDF
    </button>
  );
}

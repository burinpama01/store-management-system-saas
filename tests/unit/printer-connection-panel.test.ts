import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildNetworkPrinterTestPayload,
  resolvePrinterConnectionState,
} from "@/modules/printing/PrinterConnectionPanel";
import { bytesToBase64 } from "@/modules/printing/print-job-base64";
import type { Printer } from "@/modules/stores/types";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");
const globalWithDocument = globalThis as typeof globalThis & { document?: unknown };
const originalDocument = globalWithDocument.document;

function restoreDocument() {
  if (originalDocument === undefined) {
    Reflect.deleteProperty(globalWithDocument, "document");
    return;
  }
  Object.defineProperty(globalWithDocument, "document", { configurable: true, value: originalDocument });
}

function installFakeCanvasDocument() {
  Object.defineProperty(globalWithDocument, "document", {
    configurable: true,
    value: {
      createElement(tagName: string) {
        if (tagName !== "canvas") throw new Error(`Unexpected fake DOM element: ${tagName}`);
        return {
          width: 0,
          height: 0,
          getContext(type: string) {
            if (type !== "2d") return null;
            return {
              fillStyle: "",
              font: "",
              textAlign: "left",
              textBaseline: "top",
              fillRect() {},
              fillText() {},
              getImageData(_x: number, _y: number, width: number, height: number) {
                const data = new Uint8ClampedArray(width * height * 4);
                for (let i = 0; i < data.length; i += 4) {
                  data[i] = 255;
                  data[i + 1] = 255;
                  data[i + 2] = 255;
                  data[i + 3] = 255;
                }
                return { data };
              },
            };
          },
        };
      },
    },
  });
}

afterEach(() => {
  restoreDocument();
});

describe("PrinterConnectionPanel connection state", () => {
  it("does not mark a remembered printer as ready after refresh", () => {
    const state = resolvePrinterConnectionState({
      bluetoothName: "BT Printer",
      usbName: null,
      bluetoothConnected: false,
      usbConnected: false,
    });

    expect(state.connectedDevice).toBeNull();
    expect(state.rememberedDevice).toEqual({ kind: "Bluetooth (จำไว้)", name: "BT Printer" });
  });

  it("marks a live Bluetooth session as ready when the panel remounts", () => {
    const state = resolvePrinterConnectionState({
      bluetoothName: "BT Printer",
      usbName: null,
      bluetoothConnected: true,
      usbConnected: false,
    });

    expect(state.connectedDevice).toEqual({ kind: "Bluetooth", name: "BT Printer" });
    expect(state.rememberedDevice).toBeNull();
  });

  it("marks a live USB session as ready when only USB is connected", () => {
    const state = resolvePrinterConnectionState({
      bluetoothName: null,
      usbName: "USB Printer",
      bluetoothConnected: false,
      usbConnected: true,
    });

    expect(state.connectedDevice).toEqual({ kind: "USB", name: "USB Printer" });
    expect(state.rememberedDevice).toBeNull();
  });
});

describe("PrinterConnectionPanel network printer controls", () => {
  it("surfaces IP/WiFi printer controls on receipt settings", () => {
    const panel = read("src/modules/printing/PrinterConnectionPanel.tsx");
    const page = read("src/app/(dashboard)/settings/receipt/page.tsx");
    const posTerminal = read("src/app/pos/PosTerminal.tsx");
    const receiptTests = read("src/app/(dashboard)/settings/receipt/ReceiptTests.tsx");
    const actions = read("src/app/(dashboard)/settings/receipt/actions.ts");
    const repository = read("src/modules/stores/repository.ts");

    expect(panel).toContain("IP / WiFi");
    expect(panel).toContain("sendNetworkPrintJob");
    expect(panel).toContain("buildNetworkPrinterTestPayload(printer, storeName, paperWidth)");
    expect(panel).toContain("printJobBase64");
    expect(panel).toContain("saveNetworkPrinterAction");
    expect(panel).toContain('name="ipAddress"');
    expect(panel).toContain('name="port"');
    expect(panel).toContain("IP / WiFi ·");
    expect(actions).toContain("normalizeNetworkPrinterEndpoint");
    expect(actions).toContain("upsertNetworkPrinter");
    expect(repository).toContain("upsertNetworkPrinter");
    // Within any one upsert function, default-clearing must come AFTER the
    // upsert query (never before). Scoped to a single function body so a second
    // upsert function (e.g. Bluetooth) does not create a cross-boundary match.
    expect(repository).not.toMatch(/if \(input\.isDefault\)(?:(?!export async function)[\s\S])*?const query = input\.id/);
    expect(page).toContain("listPrinters");
    expect(page).toMatch(/<PrinterConnect[\s\S]*printers={printersRes\.data}/);
    expect(page).toMatch(/<ReceiptTests[\s\S]*printers={printersRes\.data}/);
    expect(posTerminal).toMatch(/<PrinterConnectionPanel(?=[^>]*variant="compact")(?=[^>]*printers={printers})[^>]*\/>/);
    expect(posTerminal).toMatch(/<PrinterConnectionPanel(?=[^>]*variant="compact")(?=[^>]*printerLoadError={printerLoadError})[^>]*\/>/);
    expect(posTerminal).toMatch(/<PrinterConnectionPanel(?=[^>]*variant="compact")(?=[^>]*storeName={receiptSettings\?\.storeName \?\? storeName})[^>]*\/>/);
    expect(posTerminal).toMatch(/<PrinterConnectionPanel(?=[^>]*variant="compact")(?=[^>]*paperWidth={receiptSettings\?\.paperWidth \?\? "80mm"})[^>]*\/>/);
    expect(posTerminal).toMatch(/<PrinterConnectionPanel(?=[^>]*variant="compact")(?=[^>]*onNetworkPrinterSelect={setPreferredPrinterId})[^>]*\/>/);
    expect(posTerminal).toContain("const [preferredPrinterId, setPreferredPrinterId] = useState<string | null>(null)");
    expect(posTerminal).toContain("preferredPrinterId: preferredPrinterIdForPrint");
    expect(posTerminal).toContain("preferredPrinterId={preferredPrinterIdForPrint}");
    expect(receiptTests).toContain("networkPrinters");
  });

  it("keeps POS compact IP/WiFi selection separate from physical test printing", () => {
    const panel = read("src/modules/printing/PrinterConnectionPanel.tsx");

    expect(panel).toContain('variant === "compact" ? markNetworkPrinterReady(printer) : void testNetworkPrinter(printer)');
    expect(panel).toContain("onNetworkPrinterSelect?.(printer.id)");
    expect(panel).toContain('variant === "compact" ? "max-w-52 truncate whitespace-nowrap" : ""');
    expect(panel).toContain("กดเพื่อเลือกเครื่องนี้");
    expect(panel).toContain("กดเพื่อพิมพ์ทดสอบ");
  });

  it("builds a raster print job for the IP/WiFi printer test button payload", async () => {
    installFakeCanvasDocument();
    const printer = {
      id: "printer-ip-1",
      storeId: "store-1",
      organizationId: "org-1",
      name: "เครื่องพิมพ์ WiFi",
      type: "ip",
      isDefault: true,
      ipAddress: "192.168.1.50",
      port: 9100,
      paperWidth: "80mm",
      createdAt: "2026-06-24T00:00:00.000Z",
      updatedAt: "2026-06-24T00:00:00.000Z",
    } satisfies Printer;

    const payload = await buildNetworkPrinterTestPayload(printer, "each other home&cafe", "58mm");
    const bytes = new Uint8Array(Buffer.from(payload.printJobBase64, "base64"));
    const rasterCommandIndex = bytes.findIndex((value, index, array) =>
      value === 0x1d && array[index + 1] === 0x76 && array[index + 2] === 0x30,
    );

    expect(payload.printerId).toBe("printer-ip-1");
    expect(payload.receiptData.paperWidth).toBe("80mm");
    expect(payload.receiptData.items[0]?.name).toBe("ทดสอบ IP / WiFi");
    expect(payload.printJobBase64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect([...bytes.slice(0, 2)]).toEqual([0x1b, 0x40]); // ESC @
    expect(rasterCommandIndex).toBeGreaterThan(1); // GS v 0 raster image command
  });

  it("encodes large print jobs to base64 without dropping bytes at chunk boundaries", () => {
    const bytes = new Uint8Array(0x8000 + 513);
    bytes.forEach((_, index) => {
      bytes[index] = index % 256;
    });

    expect(new Uint8Array(Buffer.from(bytesToBase64(bytes), "base64"))).toEqual(bytes);
  });
});

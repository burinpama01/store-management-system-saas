import type { PrintAdapter, ReceiptData } from "../types";
import type { Printer } from "@/modules/stores/types";
import { buildReceiptPrinterBytes } from "../receipt-printer-bytes";

declare global {
  interface Navigator {
    usb?: {
      requestDevice(options: { filters: { vendorId?: number; productId?: number }[] }): Promise<USBDevice>;
      getDevices(): Promise<USBDevice[]>;
    };
  }
  interface USBDevice {
    vendorId: number;
    productId: number;
    opened: boolean;
    open(): Promise<void>;
    close(): Promise<void>;
    claimInterface(interfaceNumber: number): Promise<void>;
    releaseInterface(interfaceNumber: number): Promise<void>;
    transferOut(endpointNumber: number, data: BufferSource): Promise<USBOutTransferResult>;
    configuration: USBConfiguration | null;
  }
  interface USBConfiguration {
    interfaces: USBInterface[];
  }
  interface USBInterface {
    interfaceNumber: number;
    alternates: USBAlternateInterface[];
  }
  interface USBAlternateInterface {
    endpoints: USBEndpoint[];
  }
  interface USBEndpoint {
    endpointNumber: number;
    direction: "in" | "out";
  }
  interface USBOutTransferResult {
    status: "ok" | "stall" | "babble";
    bytesWritten: number;
  }
}

function findOutEndpoint(device: USBDevice): { interfaceNum: number; endpointNum: number } | null {
  for (const iface of device.configuration?.interfaces ?? []) {
    for (const alt of iface.alternates) {
      for (const ep of alt.endpoints) {
        if (ep.direction === "out") {
          return { interfaceNum: iface.interfaceNumber, endpointNum: ep.endpointNumber };
        }
      }
    }
  }
  return null;
}

export const usbAdapter: PrintAdapter = {
  name: "usb",

  async isAvailable(): Promise<boolean> {
    return typeof navigator !== "undefined" && !!navigator.usb;
  },

  async print(data: ReceiptData, printer: Printer): Promise<void> {
    if (!navigator.usb) throw new Error("WebUSB ไม่รองรับในเบราว์เซอร์นี้");

    // Find existing paired device or request new one
    let device: USBDevice | undefined;
    const existing = await navigator.usb.getDevices();
    const vendorId = printer.usbVendorId ? parseInt(printer.usbVendorId, 16) : undefined;
    const productId = printer.usbProductId ? parseInt(printer.usbProductId, 16) : undefined;

    if (vendorId && productId) {
      device = existing.find((d) => d.vendorId === vendorId && d.productId === productId);
    }
    if (!device) {
      const filters = vendorId ? [{ vendorId, productId }] : [];
      device = await navigator.usb.requestDevice({ filters });
    }

    await device.open();
    const ep = findOutEndpoint(device);
    if (!ep) {
      await device.close();
      throw new Error("ไม่พบ USB out endpoint บนเครื่องพิมพ์");
    }

    try {
      await device.claimInterface(ep.interfaceNum);
      const bytes = buildReceiptPrinterBytes(data, data);
      await device.transferOut(ep.endpointNum, bytes.buffer as ArrayBuffer);
    } finally {
      await device.releaseInterface(ep.interfaceNum).catch(() => undefined);
      await device.close().catch(() => undefined);
    }
  },
};

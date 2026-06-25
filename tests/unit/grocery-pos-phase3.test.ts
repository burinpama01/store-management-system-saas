import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCustomerDisplaySnapshot,
  CUSTOMER_DISPLAY_CHANNEL,
  resolveCustomerDisplayPublishCart,
  validateCustomerDisplayMessage,
} from "@/modules/grocery-pos/customer-display";
import { normalizeNetworkPrinterEndpoint } from "@/modules/printing/network-printer";
import type { Cart } from "@/modules/pos/types";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

function cart(overrides: Partial<Cart> = {}): Cart {
  return {
    storeId: "store-1",
    items: [
      {
        key: "p1||",
        productId: "p1",
        productName: "น้ำดื่ม",
        categoryId: "cat-1",
        variant: null,
        modifiers: [],
        quantity: 2,
        unitPrice: 10,
        totalPrice: 20,
        note: "internal note",
      },
    ],
    subtotal: 20,
    discount: 0,
    total: 20,
    ...overrides,
  };
}

describe("grocery POS customer display", () => {
  it("builds a customer-safe display snapshot without internal item notes", () => {
    const snapshot = buildCustomerDisplaySnapshot(cart(), {
      status: "checkout",
      customerName: "คุณเอ",
    });

    expect(snapshot.channel).toBe(CUSTOMER_DISPLAY_CHANNEL);
    expect(snapshot.status).toBe("checkout");
    expect(snapshot.customerName).toBe("คุณเอ");
    expect(snapshot.items).toEqual([
      {
        name: "น้ำดื่ม",
        variantName: undefined,
        options: [],
        quantity: 2,
        unitPrice: 10,
        totalPrice: 20,
      },
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("internal note");
    expect(validateCustomerDisplayMessage(snapshot)).toBe(true);
  });

  it("shows modifier option names and customer points without option prices", () => {
    const customerWithPhone = {
      name: "Ada",
      phone: "0800000000",
      pointsEarned: 6,
      pointsBalance: 126,
    };

    const snapshot = buildCustomerDisplaySnapshot(
      cart({
        items: [
          {
            key: "p2|large|sweet",
            productId: "p2",
            productName: "Iced tea",
            categoryId: "cat-1",
            variant: { id: "large", name: "Large", priceAdjustment: 10 },
            modifiers: [
              {
                modifierGroupId: "sweetness",
                modifierGroupName: "Sweetness",
                option: { id: "less", name: "Less sweet", priceAdjustment: -5 },
              },
              {
                modifierGroupId: "topping",
                modifierGroupName: "Topping",
                option: { id: "boba", name: "Boba", priceAdjustment: 15 },
              },
            ],
            quantity: 1,
            unitPrice: 40,
            totalPrice: 60,
          },
        ],
        subtotal: 60,
        total: 60,
      }),
      {
        status: "checkout",
        customer: customerWithPhone,
      },
    );

    expect(snapshot.customerName).toBe("Ada");
    expect(snapshot.customer).toEqual({
      name: "Ada",
      pointsEarned: 6,
      pointsBalance: 126,
    });
    expect(JSON.stringify(snapshot)).not.toContain("0800000000");
    expect(snapshot.items[0]).toMatchObject({
      name: "Iced tea",
      variantName: "Large",
      options: ["Sweetness: Less sweet", "Topping: Boba"],
    });
    expect(JSON.stringify(snapshot.items[0].options)).not.toContain("-5");
    expect(JSON.stringify(snapshot.items[0].options)).not.toContain("15");
    expect(JSON.stringify(snapshot.items[0].options)).not.toContain("priceAdjustment");
    expect(validateCustomerDisplayMessage(snapshot)).toBe(true);
    expect(validateCustomerDisplayMessage({ ...snapshot, customer: { pointsBalance: Number.NaN } })).toBe(false);
  });

  it("carries locked PromptPay QR details in checkout snapshots", () => {
    const snapshot = buildCustomerDisplaySnapshot(cart(), {
      status: "checkout",
      payment: {
        method: "qr_promptpay",
        amount: 20,
        promptPayPayload: "00020101021229370016A000000677010111011300668123456785802TH5303764540520.0063046D36",
      },
    } as Parameters<typeof buildCustomerDisplaySnapshot>[1] & {
      payment: { method: "qr_promptpay"; amount: number; promptPayPayload: string };
    });

    expect(snapshot.payment).toEqual({
      method: "qr_promptpay",
      amount: 20,
      promptPayPayload: "00020101021229370016A000000677010111011300668123456785802TH5303764540520.0063046D36",
    });
    expect(validateCustomerDisplayMessage(snapshot)).toBe(true);
    expect(validateCustomerDisplayMessage({ ...snapshot, payment: { method: "qr_promptpay", amount: 0, promptPayPayload: "" } })).toBe(false);
  });

  it("keeps the paid customer display on the final paid cart while the cashier clears the live cart", () => {
    const paidCart = cart({ total: 70, subtotal: 70 });
    const liveEmptyCart = cart({ items: [], subtotal: 0, discount: 0, total: 0 });

    expect(
      resolveCustomerDisplayPublishCart({
        liveCart: liveEmptyCart,
        paidCart,
        status: "paid",
      }),
    ).toBe(paidCart);

    expect(
      resolveCustomerDisplayPublishCart({
        liveCart: liveEmptyCart,
        paidCart,
        status: "idle",
      }),
    ).toBe(liveEmptyCart);
  });

  it("adds a dedicated display route that listens through BroadcastChannel", () => {
    const page = read("src/app/pos/grocery/display/page.tsx");
    const screen = read("src/app/pos/grocery/display/CustomerDisplayScreen.tsx");
    const terminal = read("src/app/pos/grocery/GroceryPosTerminal.tsx");

    expect(page).toContain('requirePermission("pos.use")');
    expect(page).toContain('requireFeature("customerDisplay")');
    expect(screen).toContain("new BroadcastChannel(CUSTOMER_DISPLAY_CHANNEL)");
    expect(screen).toContain("validateCustomerDisplayMessage");
    expect(screen).toContain("QrCode");
    expect(screen).toContain("QR พร้อมเพย์ล็อกยอด");
    expect(screen).toContain("customer-display-layout");
    expect(screen).toContain("customer-display-ad-panel");
    expect(screen).toContain("customer-display-options");
    expect(screen).toContain("customer-display-points");
    expect(screen).not.toContain("customer.phone");
    expect(terminal).toContain("publishCustomerDisplaySnapshot");
    expect(terminal).toContain("customer: status === \"paid\"");
    expect(terminal).toContain("pointsBalance: selectedCustomer.pointsBalance");
    expect(terminal).not.toContain("phone: selectedCustomer.phone");
  });
});

describe("grocery POS network printer phase 3", () => {
  it("normalizes only DB-configured private LAN printer endpoints", () => {
    expect(normalizeNetworkPrinterEndpoint({ host: "192.168.1.40", port: 9100 })).toEqual({
      host: "192.168.1.40",
      port: 9100,
    });
    expect(() => normalizeNetworkPrinterEndpoint({ host: "8.8.8.8", port: 9100 })).toThrow("Invalid or disallowed IP address");
    expect(() => normalizeNetworkPrinterEndpoint({ host: "192.168.1.40", port: 70000 })).toThrow("Invalid port number");
  });

  it("adds a printer health route that resolves host and port from store printer config only", () => {
    const route = read("src/app/api/print/ip/health/route.ts");

    expect(route).toContain("getPrinter(printerId, ctx.storeId, ctx.organizationId)");
    expect(route).toContain('requireFeature("advancedPrinting")');
    expect(route).toContain('requireRole("manager")');
    expect(route).toContain("normalizeNetworkPrinterEndpoint");
    expect(route).toContain("probeNetworkPrinter");
    expect(route).toContain("printerId");
    expect(route).not.toContain("body.host");
    expect(route).not.toContain("body.ipAddress");
  });
});

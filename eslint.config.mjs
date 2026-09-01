import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    ".vercel/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // U0.5/U8 hygiene: dot workspaces + generated artifacts (same exclusions as vitest discovery)
    ".codex/**",
    ".codex-temp/**",
    ".codex-remote-attachments/**",
    ".worktrees/**",
    ".playwright-cli/**",
    "test-results/**",
    "playwright-report/**",
    "graphify-out/**",
    "output/**",
    "artifacts/**",
  ]),
  // U8 gate (2026-09-01): quarantine กฎ react-hooks/set-state-in-effect เฉพาะ 5 ไฟล์ legacy
  // ก่อน R1 (v0.33-v0.34) — กฎยังบังคับกับไฟล์อื่นทั้งหมด
  // TODO: แก้ตาม https://react.dev/learn/you-might-not-need-an-effect แล้วลบ override นี้
  {
    files: [
      "src/app/(dashboard)/DeliveryGlobalNotifier.tsx",
      "src/app/(dashboard)/settings/devices/DeviceCenter.tsx",
      "src/app/pos/grocery/GroceryPosTerminal.tsx",
      "src/modules/printing/PrinterConnectionPanel.tsx",
      "src/shared/components/CommandPalette.tsx",
    ],
    rules: { "react-hooks/set-state-in-effect": "off" },
  },
]);

export default eslintConfig;

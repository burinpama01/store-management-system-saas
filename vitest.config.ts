import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

// U8 part 1.5: exclude ชุดเดิมของ U0.5 ใช้ร่วมกันทั้ง root และทุก project
const TEST_EXCLUDE = [
  ...configDefaults.exclude,
  // กัน vitest discovery ปน temp/worktrees/attachments/ไฟล์ e2e ของ Playwright
  ".codex-temp/**",
  ".worktrees/**",
  ".codex-remote-attachments/**",
  ".next/**",
  "dist/**",
  "out/**",
  "node_modules/**",
  "tests/e2e/**",
  "test-results/**",
  "playwright-report/**",
];

const TEST_ALIAS = { "@": path.resolve(__dirname, "./src") };

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    exclude: TEST_EXCLUDE,
    // U8 part 1.5: integration files แชร์ seed fixture เดิม (VARIANT_1, STORE_A/B,
    // store flags) — ห้ามรันไฟล์ขนานกัน จึงแยก project ให้รันไฟล์ตามลำดับ
    // หมายเหตุ: vitest 3.2 ไม่ inherit root config ให้ project และ fileParallelism
    // เป็น root-only option จึงต้องประกาศครบทุก project + ใช้ forks.singleFork แทน
    projects: [
      {
        test: {
          name: "unit",
          globals: false,
          environment: "node",
          include: ["tests/unit/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
          exclude: TEST_EXCLUDE,
        },
        resolve: { alias: TEST_ALIAS },
      },
      {
        test: {
          name: "integration",
          globals: false,
          environment: "node",
          include: ["tests/integration/**/*.{test,spec}.?(c|m)[jt]s?(x)"],
          exclude: TEST_EXCLUDE,
          // ไฟล์ทั้ง project รันตามลำดับใน fork เดียว (unit project ยังรันขนานตาม default)
          poolOptions: { forks: { singleFork: true } },
        },
        resolve: { alias: TEST_ALIAS },
      },
    ],
  },
  resolve: { alias: TEST_ALIAS },
});

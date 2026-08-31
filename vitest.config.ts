import { defineConfig, configDefaults } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
    // U0.5: กัน vitest discovery ปน temp/worktrees/attachments/ไฟล์ e2e ของ Playwright
    exclude: [
      ...configDefaults.exclude,
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
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});

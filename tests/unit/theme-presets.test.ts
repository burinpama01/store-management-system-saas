import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CUSTOM_THEME_PRESET_ID,
  THEME_PRESETS,
  buildThemeStyle,
  resolveThemeSelection,
} from "../../src/modules/theme/presets";

const root = process.cwd();

function read(path: string) {
  return readFileSync(join(root, path), "utf8");
}

describe("theme presets", () => {
  it("keeps built-in presets and custom theme tokens valid", () => {
    expect(THEME_PRESETS.length).toBeGreaterThanOrEqual(5);
    expect(THEME_PRESETS.map((preset) => preset.id)).toContain(CUSTOM_THEME_PRESET_ID);

    for (const preset of THEME_PRESETS) {
      expect(preset.name).toBeTruthy();
      expect(preset.colors.primary).toMatch(/^#[0-9a-f]{6}$/i);
      expect(preset.colors.primaryStrong).toMatch(/^#[0-9a-f]{6}$/i);
      expect(preset.colors.primarySoft).toMatch(/^#[0-9a-f]{6}$/i);
      expect(preset.colors.accent).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it("resolves built-in presets and custom colors with fail-closed validation", () => {
    expect(resolveThemeSelection({ presetId: "matcha-garden" })).toEqual({
      ok: true,
      theme: {
        presetId: "matcha-garden",
        primaryColor: "#5b8c51",
        primaryStrongColor: "#416d39",
        primarySoftColor: "#ecf3e8",
        accentColor: "#c2851f",
      },
    });

    expect(
      resolveThemeSelection({
        presetId: CUSTOM_THEME_PRESET_ID,
        primaryColor: "#123abc",
        primaryStrongColor: "#0f2a80",
        primarySoftColor: "#eef3ff",
        accentColor: "#00a1b2",
      }),
    ).toEqual({
      ok: true,
      theme: {
        presetId: CUSTOM_THEME_PRESET_ID,
        primaryColor: "#123abc",
        primaryStrongColor: "#0f2a80",
        primarySoftColor: "#eef3ff",
        accentColor: "#00a1b2",
      },
    });

    expect(
      resolveThemeSelection({
        presetId: CUSTOM_THEME_PRESET_ID,
        primaryColor: "red",
        primaryStrongColor: "#0f2a80",
        primarySoftColor: "#eef3ff",
        accentColor: "#00a1b2",
      }),
    ).toEqual({
      ok: false,
        error: "สี Theme ต้องเป็นรหัส HEX เช่น #c2603a",
      });

    expect(resolveThemeSelection({ presetId: "bad-id" })).toEqual({
      ok: false,
      error: "Theme preset ไม่ถูกต้อง",
    });
  });

  it("builds dashboard CSS variables from the selected store theme", () => {
    expect(
      buildThemeStyle({
        presetId: CUSTOM_THEME_PRESET_ID,
        primaryColor: "#123abc",
        primaryStrongColor: "#0f2a80",
        primarySoftColor: "#eef3ff",
        accentColor: "#00a1b2",
      }),
    ).toEqual({
      "--tenant-primary": "#123abc",
      "--tenant-primary-strong": "#0f2a80",
      "--tenant-primary-soft": "#eef3ff",
      "--tenant-accent": "#00a1b2",
    });
  });

  it("wires store theme persistence through settings UI, action, repository, and layout", () => {
    const form = read("src/app/(dashboard)/settings/store/StoreSettingsForm.tsx");
    const action = read("src/app/(dashboard)/settings/store/actions.ts");
    const repository = read("src/modules/stores/repository.ts");
    const types = read("src/modules/stores/types.ts");
    const layout = read("src/app/(dashboard)/layout.tsx");
    const posPage = read("src/app/pos/page.tsx");

    expect(form).toContain("THEME_PRESETS");
    expect(form).toContain("themePresetId");
    expect(form).toContain("Custom");
    expect(form).toContain("themePrimaryColor");
    expect(form).not.toContain("Preview only");

    expect(action).toContain("resolveThemeSelection");
    expect(action).toContain("themePresetId");
    expect(action).toContain("themePrimaryColor");

    expect(repository).toContain("theme_preset_id");
    expect(repository).toContain("theme_primary_color");
    expect(repository).toContain("theme_accent_color");

    expect(types).toContain("themePresetId");
    expect(types).toContain("themePrimaryColor");
    expect(layout).toContain("buildThemeStyle");
    expect(layout).toContain("style={themeStyle}");
    expect(posPage).toContain("buildThemeStyle");
    expect(posPage).toContain("style={themeStyle}");
  });
});

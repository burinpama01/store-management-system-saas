export const CUSTOM_THEME_PRESET_ID = "custom";

export interface ThemeTokens {
  presetId: string;
  primaryColor: string;
  primaryStrongColor: string;
  primarySoftColor: string;
  accentColor: string;
}

export interface ThemePreset {
  id: string;
  name: string;
  description: string;
  colors: {
    primary: string;
    primaryStrong: string;
    primarySoft: string;
    accent: string;
  };
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: "caramel-cafe",
    name: "Caramel Cafe",
    description: "อบอุ่น เหมาะกับคาเฟ่และร้านอาหาร",
    colors: {
      primary: "#c2603a",
      primaryStrong: "#a8492a",
      primarySoft: "#fbede4",
      accent: "#3c8fb0",
    },
  },
  {
    id: "matcha-garden",
    name: "Matcha Garden",
    description: "เขียวสะอาดสำหรับร้านสุขภาพหรือชา",
    colors: {
      primary: "#5b8c51",
      primaryStrong: "#416d39",
      primarySoft: "#ecf3e8",
      accent: "#c2851f",
    },
  },
  {
    id: "berry-bloom",
    name: "Berry Bloom",
    description: "สดใสสำหรับของหวานและร้าน lifestyle",
    colors: {
      primary: "#b65c8a",
      primaryStrong: "#8f3f69",
      primarySoft: "#fbeaf2",
      accent: "#7a6bc4",
    },
  },
  {
    id: "ocean-retail",
    name: "Ocean Retail",
    description: "คม ชัด สำหรับร้านค้าปลีกและบริการ",
    colors: {
      primary: "#2563eb",
      primaryStrong: "#1d4ed8",
      primarySoft: "#dbeafe",
      accent: "#0891b2",
    },
  },
  {
    id: CUSTOM_THEME_PRESET_ID,
    name: "Custom",
    description: "กำหนดสีแบรนด์เอง",
    colors: {
      primary: "#c2603a",
      primaryStrong: "#a8492a",
      primarySoft: "#fbede4",
      accent: "#3c8fb0",
    },
  },
];

export const DEFAULT_THEME = toThemeTokens(THEME_PRESETS[0]);

const HEX_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function toThemeTokens(preset: ThemePreset): ThemeTokens {
  return {
    presetId: preset.id,
    primaryColor: preset.colors.primary,
    primaryStrongColor: preset.colors.primaryStrong,
    primarySoftColor: preset.colors.primarySoft,
    accentColor: preset.colors.accent,
  };
}

function normalizeHex(value: string | null | undefined): string | null {
  const color = value?.trim();
  if (!color || !HEX_COLOR_PATTERN.test(color)) return null;
  return color.toLowerCase();
}

export function getThemePreset(presetId: string | null | undefined): ThemePreset {
  return THEME_PRESETS.find((preset) => preset.id === presetId) ?? THEME_PRESETS[0];
}

export function resolveThemeSelection(input: {
  presetId?: string | null;
  primaryColor?: string | null;
  primaryStrongColor?: string | null;
  primarySoftColor?: string | null;
  accentColor?: string | null;
}): { ok: true; theme: ThemeTokens } | { ok: false; error: string } {
  const preset = THEME_PRESETS.find((item) => item.id === input.presetId);
  if (!preset) return { ok: false, error: "Theme preset ไม่ถูกต้อง" };

  if (preset.id !== CUSTOM_THEME_PRESET_ID) {
    return { ok: true, theme: toThemeTokens(preset) };
  }

  const primaryColor = normalizeHex(input.primaryColor);
  const primaryStrongColor = normalizeHex(input.primaryStrongColor);
  const primarySoftColor = normalizeHex(input.primarySoftColor);
  const accentColor = normalizeHex(input.accentColor);
  if (!primaryColor || !primaryStrongColor || !primarySoftColor || !accentColor) {
    return { ok: false, error: "สี Theme ต้องเป็นรหัส HEX เช่น #c2603a" };
  }

  return {
    ok: true,
    theme: {
      presetId: CUSTOM_THEME_PRESET_ID,
      primaryColor,
      primaryStrongColor,
      primarySoftColor,
      accentColor,
    },
  };
}

export function buildThemeStyle(theme: ThemeTokens): Record<string, string> {
  return {
    "--tenant-primary": theme.primaryColor,
    "--tenant-primary-strong": theme.primaryStrongColor,
    "--tenant-primary-soft": theme.primarySoftColor,
    "--tenant-accent": theme.accentColor,
  };
}

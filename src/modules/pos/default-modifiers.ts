import type { ModifierGroup, ModifierOption } from "@/modules/catalog/types";

const STANDARD_POS_DEFAULTS: Array<{ groupIncludes: string[]; optionNames: string[] }> = [
  { groupIncludes: ["ความหวาน"], optionNames: ["100%"] },
  { groupIncludes: ["นม"], optionNames: ["นมสด"] },
  { groupIncludes: ["ประเภท"], optionNames: ["เย็น"] },
];

function normalize(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function preferredOptionNames(groupName: string): Set<string> {
  const normalizedGroupName = normalize(groupName);
  const match = STANDARD_POS_DEFAULTS.find((rule) =>
    rule.groupIncludes.some((keyword) => normalizedGroupName.includes(normalize(keyword))),
  );
  return new Set((match?.optionNames ?? []).map(normalize));
}

function clampSelection(group: ModifierGroup, options: ModifierOption[]): ModifierOption[] {
  const max = group.selectionType === "single" ? 1 : group.maxSelections;
  return options.slice(0, Math.max(0, max));
}

function shouldUseNameFallback(group: ModifierGroup): boolean {
  return group.isRequired || group.minSelections > 0;
}

export function buildDefaultModifierSelections(groups: ModifierGroup[]): Record<string, ModifierOption[]> {
  return groups.reduce<Record<string, ModifierOption[]>>((acc, group) => {
    const activeOptions = group.options.filter((option) => option.isActive);
    const configuredDefaults = clampSelection(group, activeOptions.filter((option) => option.isDefault));

    if (configuredDefaults.length > 0) {
      acc[group.id] = configuredDefaults;
      return acc;
    }

    const preferredNames = preferredOptionNames(group.name);
    if (preferredNames.size === 0 || !shouldUseNameFallback(group)) return acc;

    const preferredDefaults = clampSelection(
      group,
      activeOptions.filter((option) => preferredNames.has(normalize(option.name))),
    );

    if (preferredDefaults.length > 0) {
      acc[group.id] = preferredDefaults;
    }

    return acc;
  }, {});
}

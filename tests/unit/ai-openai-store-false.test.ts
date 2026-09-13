import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** ISSUE-20260904-001 — every OpenAI generateText path must opt out of store persistence. */
const AI_MODULES = ["gateway.ts", "menu-scan.ts", "voice-intent.ts"] as const;

describe("OpenAI store=false contract (ISSUE-20260904-001)", () => {
  it.each(AI_MODULES)("%s sets providerOptions.openai.store=false near generateText", (file) => {
    const src = readFileSync(join(process.cwd(), "src/modules/ai", file), "utf8");
    expect(src).toMatch(/generateText\s*\(/);
    expect(src).toMatch(/providerOptions\s*:\s*\{\s*openai\s*:\s*\{\s*store\s*:\s*false\s*\}\s*\}/);
  });
});
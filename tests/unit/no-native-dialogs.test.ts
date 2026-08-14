import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function collectSourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (entry.endsWith(".ts") || entry.endsWith(".tsx")) {
      acc.push(full);
    }
  }
  return acc;
}

describe("no native browser dialogs in app code", () => {
  // window.confirm/alert/prompt never open inside the mobile app WebView or a
  // cross-origin iframe: confirm() returns false immediately, so the guarded
  // action silently does nothing and the user sees no feedback. Use useConfirm()
  // (in-app ConfirmDialog) or inline error state instead.
  const files = collectSourceFiles(join(root, "src"));

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("never calls window.confirm / window.alert / window.prompt", () => {
    const offenders = files.filter((file) =>
      /window\.(confirm|alert|prompt)\s*\(/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => f.slice(root.length + 1))).toEqual([]);
  });

  it("never calls the bare global confirm()/alert() with a message", () => {
    // useConfirm's confirm() always takes an options object, so a string or
    // template-literal argument means the native global slipped back in.
    const offenders = files.filter((file) =>
      /(?<![.\w])(confirm|alert|prompt)\s*\(\s*[`"']/.test(readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => f.slice(root.length + 1))).toEqual([]);
  });
});

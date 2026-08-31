// @vitest-environment jsdom
// U0.5 — smoke test ของ branch jsdom ใน tests/setup/react.ts (review Major 1)
// พิสูจน์ว่า stack jsdom 29 + RTL 16.3 + React 19 + jest-dom 7 รันได้จริงบน vitest 3
import { cleanup, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import "../setup/react";

function Dummy() {
  return <p>สวัสดี StoreOS</p>;
}

describe("tests/setup/react.ts บน jsdom environment", () => {
  it("มี document จริง และ render + jest-dom matcher ใช้ได้", () => {
    expect(typeof document).not.toBe("undefined");
    render(<Dummy />);
    expect(screen.getByText("สวัสดี StoreOS")).toBeInTheDocument();
    cleanup();
  });

  it("cleanup ที่ setup register ผ่าน afterEach ไม่ throw", () => {
    expect(() => cleanup()).not.toThrow();
  });
});

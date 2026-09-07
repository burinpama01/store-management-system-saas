// @vitest-environment jsdom
import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LandingPlayground } from "@/shared/components/marketing/LandingPlayground";
import { LandingStoreLogos } from "@/shared/components/marketing/LandingStoreLogos";

const { createScene, dispose, pause, rotate } = vi.hoisted(() => ({
  createScene: vi.fn(), dispose: vi.fn(), pause: vi.fn(), rotate: vi.fn(),
}));
vi.mock("@/shared/components/marketing/landing-shop-scene", () => ({ createShopScene: createScene }));

let enterViewport: IntersectionObserverCallback;
let changeMotion: () => void;
let reducedMotion = false;
beforeEach(() => {
  vi.clearAllMocks();
  reducedMotion = false;
  createScene.mockReturnValue({ dispose, pause, rotate });
  vi.stubGlobal("React", React);
  vi.stubGlobal("matchMedia", () => ({
    get matches() { return reducedMotion; },
    addEventListener: (_: string, listener: () => void) => { changeMotion = listener; },
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: IntersectionObserverCallback) { enterViewport = callback; }
    observe() {}
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
async function showScene() {
  await act(async () => enterViewport([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
}

describe("landing optional 3D", () => {
  it("retains a static shop and does not load WebGL for reduced motion", async () => {
    reducedMotion = true;
    const { container } = render(<LandingPlayground />);
    await showScene();
    expect(createScene).not.toHaveBeenCalled();
    expect(container.querySelector(".play-shop-fallback.is-hidden")).toBeNull();
    expect(screen.queryByRole("button", { name: "หมุนร้านไปทางซ้าย" })).toBeNull();
  });

  it("loads on visibility, supports accessible rotation/pause, and disposes on unmount", async () => {
    const { unmount } = render(<LandingPlayground />);
    expect(createScene).not.toHaveBeenCalled();
    await showScene();
    fireEvent.click(await screen.findByRole("button", { name: "หมุนร้านไปทางขวา" }));
    expect(rotate).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole("button", { name: "หยุดภาพ" }));
    expect(pause).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "เล่นต่อ" }).getAttribute("aria-pressed")).toBe("true");
    unmount();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("returns to static content when WebGL fails", async () => {
    createScene.mockImplementationOnce(() => { throw new Error("WebGL unavailable"); });
    const { container } = render(<LandingPlayground />);
    await showScene();
    expect(container.querySelector(".play-shop-fallback.is-hidden")).toBeNull();
    expect(screen.getByText("ร้านเล็ก ร้านใหญ่ จัดการได้ในที่เดียว")).toBeTruthy();
  });

  it("disposes on context loss and when reduced motion changes during use", async () => {
    const { container } = render(<LandingPlayground />);
    await showScene();
    fireEvent(container.querySelector(".play-scene")!, new Event("shop-scene-unavailable"));
    expect(dispose).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "หยุดภาพ" })).toBeNull();
    await showScene();
    await waitFor(() => expect(createScene).toHaveBeenCalledTimes(2));
    act(() => { reducedMotion = true; changeMotion(); });
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(container.querySelector(".play-shop-fallback.is-hidden")).toBeNull();
  });

  it("does not create a scene after unmount while the lazy module is pending", async () => {
    const { unmount } = render(<LandingPlayground />);
    act(() => { enterViewport([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver); unmount(); });
    await act(async () => { await Promise.resolve(); });
    expect(createScene).not.toHaveBeenCalled();
  });
});

describe("store logos", () => {
  it("hides an empty showcase and preserves a real name when an uploaded logo fails", () => {
    const { container, rerender } = render(<LandingStoreLogos stores={[]} />);
    expect(container.children).toHaveLength(0);
    rerender(<LandingStoreLogos stores={[{ name: "ร้านจริง", slug: "real", logoUrl: "https://example.com/logo.png" }]} />);
    fireEvent.error(container.querySelector("img")!);
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("ร้านจริง")).toBeTruthy();
  });
});

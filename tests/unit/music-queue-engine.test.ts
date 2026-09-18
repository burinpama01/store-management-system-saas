import { describe, it, expect } from "vitest";
import {
  orderQueue,
  selectNextTrack,
  previewDonationPosition,
  resolvePlayerInterrupt,
  type QueueItem,
} from "@/modules/music-requests/queue-engine";
import type { PlaylistTrack } from "@/modules/music-requests/types";

function item(over: Partial<QueueItem> = {}): QueueItem {
  return {
    id: "q1",
    youtubeVideoId: "vid00000001",
    title: "เพลง",
    durationSeconds: 200,
    donationStatus: "none",
    donationAmount: 0,
    requestedAt: "2026-06-29T10:00:00Z",
    ...over,
  };
}

describe("orderQueue", () => {
  it("puts verified donations first, ordered by amount desc then time", () => {
    const q = [
      item({ id: "a", donationStatus: "none", requestedAt: "2026-06-29T10:00:00Z" }),
      item({ id: "b", donationStatus: "verified", donationAmount: 50, requestedAt: "2026-06-29T10:05:00Z" }),
      item({ id: "c", donationStatus: "verified", donationAmount: 100, requestedAt: "2026-06-29T10:06:00Z" }),
      item({ id: "d", donationStatus: "none", requestedAt: "2026-06-29T09:00:00Z" }),
      item({ id: "e", donationStatus: "verified", donationAmount: 50, requestedAt: "2026-06-29T10:01:00Z" }),
    ];
    expect(orderQueue(q).map((x) => x.id)).toEqual(["c", "e", "b", "d", "a"]);
  });

  it("puts play-now donations ahead of amount-based donations", () => {
    const q = [
      item({ id: "big", donationStatus: "verified", donationAmount: 500, requestedAt: "2026-06-29T10:05:00Z" }),
      item({ id: "now1", donationStatus: "verified", donationAmount: 100, playNow: true, requestedAt: "2026-06-29T10:06:00Z" }),
      item({ id: "now2", donationStatus: "verified", donationAmount: 100, playNow: true, requestedAt: "2026-06-29T10:04:00Z" }),
      item({ id: "free", donationStatus: "none", requestedAt: "2026-06-29T09:00:00Z" }),
    ];
    // play-now (earliest first), then big donation, then free
    expect(orderQueue(q).map((x) => x.id)).toEqual(["now2", "now1", "big", "free"]);
  });

  it("treats non-verified donations as normal FIFO", () => {
    const q = [
      item({ id: "a", donationStatus: "pending", donationAmount: 999, requestedAt: "2026-06-29T10:10:00Z" }),
      item({ id: "b", donationStatus: "none", requestedAt: "2026-06-29T10:00:00Z" }),
    ];
    expect(orderQueue(q).map((x) => x.id)).toEqual(["b", "a"]);
  });
});

describe("selectNextTrack", () => {
  const base: PlaylistTrack[] = [
    { videoId: "base0000001", title: "B1" },
    { videoId: "base0000002", title: "B2" },
    { videoId: "base0000003", title: "B3" },
  ];

  it("picks the highest-priority request when the queue is non-empty", () => {
    const next = selectNextTrack([item({ id: "x", youtubeVideoId: "req00000001" })], base, null);
    expect(next).toMatchObject({ source: "request", requestId: "x", youtubeVideoId: "req00000001" });
  });

  it("cycles the base playlist when no requests", () => {
    expect(selectNextTrack([], base, null)).toMatchObject({ source: "base", youtubeVideoId: "base0000001" });
    expect(selectNextTrack([], base, "base0000001")).toMatchObject({ youtubeVideoId: "base0000002" });
    expect(selectNextTrack([], base, "base0000003")).toMatchObject({ youtubeVideoId: "base0000001" });
  });

  it("returns null when nothing is playable", () => {
    expect(selectNextTrack([], [], null)).toBeNull();
  });

  it("resumes the store song a request cut off, before cycling the playlist", () => {
    const resume = { youtubeVideoId: "live0000001", title: "Live radio" };
    expect(selectNextTrack([], base, "base0000001", resume)).toMatchObject({
      source: "base",
      youtubeVideoId: "live0000001",
      title: "Live radio",
    });
  });

  it("resumes a cut-off store song that is not in the base playlist", () => {
    const resume = { youtubeVideoId: "live0000001", title: "Live radio" };
    expect(selectNextTrack([], [], null, resume)).toMatchObject({
      source: "base",
      youtubeVideoId: "live0000001",
    });
  });

  it("still plays requests first while a store song waits to resume", () => {
    const resume = { youtubeVideoId: "live0000001", title: "Live radio" };
    expect(selectNextTrack([item({ id: "x" })], base, null, resume)).toMatchObject({
      source: "request",
      requestId: "x",
    });
  });
});

describe("resolvePlayerInterrupt — cut into the store's own song", () => {
  it("cuts in on a store song when the store enabled it", () => {
    expect(
      resolvePlayerInterrupt({
        queue: [item({ id: "x" })],
        currentSource: "base",
        interruptBaseOnRequest: true,
      }),
    ).toEqual({ interrupt: true, reason: "base_cut_in", waitingOnBase: false });
  });

  it("waits for the store song when the store disabled it (client handles live)", () => {
    expect(
      resolvePlayerInterrupt({
        queue: [item({ id: "x" })],
        currentSource: "base",
        interruptBaseOnRequest: false,
      }),
    ).toEqual({ interrupt: false, reason: null, waitingOnBase: true });
  });

  it("never cuts off another customer's request", () => {
    expect(
      resolvePlayerInterrupt({
        queue: [item({ id: "x" })],
        currentRequestId: "playing",
        currentSource: "request",
        interruptBaseOnRequest: true,
      }),
    ).toEqual({ interrupt: false, reason: null, waitingOnBase: false });
  });

  it("does not interrupt a store song with an empty queue", () => {
    expect(
      resolvePlayerInterrupt({
        queue: [],
        currentSource: "base",
        interruptBaseOnRequest: true,
      }),
    ).toEqual({ interrupt: false, reason: null, waitingOnBase: false });
  });

  it("a play-now donation interrupts even with cut-in off", () => {
    expect(
      resolvePlayerInterrupt({
        queue: [item({ id: "now", donationStatus: "verified", playNow: true })],
        currentRequestId: "playing",
        currentSource: "request",
        interruptBaseOnRequest: false,
      }),
    ).toEqual({ interrupt: true, reason: "play_now", waitingOnBase: false });
  });

  it("the play-now track already playing does not re-interrupt itself", () => {
    expect(
      resolvePlayerInterrupt({
        queue: [item({ id: "now", donationStatus: "verified", playNow: true })],
        currentRequestId: "now",
        currentSource: "request",
        interruptBaseOnRequest: true,
      }),
    ).toEqual({ interrupt: false, reason: null, waitingOnBase: false });
  });
});

describe("previewDonationPosition — privacy (returns only a position)", () => {
  const q = [
    item({ id: "a", donationStatus: "verified", donationAmount: 100 }),
    item({ id: "b", donationStatus: "verified", donationAmount: 50 }),
    item({ id: "c", donationStatus: "none" }),
  ];

  it("lands after donations with >= amount", () => {
    expect(previewDonationPosition(60, q)).toBe(2); // behind the 100, ahead of 50
    expect(previewDonationPosition(200, q)).toBe(1); // ahead of all
    expect(previewDonationPosition(10, q)).toBe(3); // behind both donations
  });

  it("a higher amount always improves position", () => {
    expect(previewDonationPosition(120, q)).toBeLessThan(previewDonationPosition(40, q));
  });
});

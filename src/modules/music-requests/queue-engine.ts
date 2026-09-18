import type { DonationStatus, PlaylistTrack } from "./types";

export interface QueueItem {
  id: string;
  youtubeVideoId: string;
  title: string;
  durationSeconds?: number;
  donationStatus: DonationStatus;
  donationAmount: number;
  /** Verified "play now" donation — interrupts and plays before everything else. */
  playNow?: boolean;
  /** ISO timestamp */
  requestedAt: string;
}

export interface NextTrack {
  source: "request" | "base";
  requestId?: string;
  youtubeVideoId: string;
  title: string;
  durationSeconds?: number;
}

function byTime(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Play order: verified donations first (amount desc, then earliest request),
 * then everything else FIFO. Non-verified donations are treated as normal.
 */
export function orderQueue(queue: QueueItem[]): QueueItem[] {
  const verified = queue.filter((q) => q.donationStatus === "verified");
  const normal = queue.filter((q) => q.donationStatus !== "verified");
  // "Play now" donations jump to the very front (earliest first), then regular
  // verified donations by amount, then everyone else FIFO.
  const playNow = verified.filter((q) => q.playNow);
  const donations = verified.filter((q) => !q.playNow);
  playNow.sort((a, b) => byTime(a.requestedAt, b.requestedAt));
  donations.sort(
    (a, b) => b.donationAmount - a.donationAmount || byTime(a.requestedAt, b.requestedAt),
  );
  normal.sort((a, b) => byTime(a.requestedAt, b.requestedAt));
  return [...playNow, ...donations, ...normal];
}

/** A store song that was cut off mid-play and should resume once the queue empties. */
export interface ResumeBaseTrack {
  youtubeVideoId: string;
  title: string;
}

/**
 * Picks the next track: the top of the ordered request queue; when the queue is
 * empty, the store song that a request cut off (resumeBase — a live stream just
 * picks up at the live edge), otherwise the next base playlist track (cycling
 * from lastBaseVideoId).
 */
export function selectNextTrack(
  queue: QueueItem[],
  basePlaylist: PlaylistTrack[],
  lastBaseVideoId: string | null,
  resumeBase: ResumeBaseTrack | null = null,
): NextTrack | null {
  const ordered = orderQueue(queue);
  if (ordered.length > 0) {
    const t = ordered[0];
    return {
      source: "request",
      requestId: t.id,
      youtubeVideoId: t.youtubeVideoId,
      title: t.title,
      durationSeconds: t.durationSeconds,
    };
  }
  if (resumeBase) {
    return {
      source: "base",
      youtubeVideoId: resumeBase.youtubeVideoId,
      title: resumeBase.title,
    };
  }
  if (basePlaylist.length > 0) {
    const idx = lastBaseVideoId
      ? basePlaylist.findIndex((t) => t.videoId === lastBaseVideoId)
      : -1;
    const next = basePlaylist[(idx + 1) % basePlaylist.length];
    return {
      source: "base",
      youtubeVideoId: next.videoId,
      title: next.title,
      durationSeconds: next.durationSeconds,
    };
  }
  return null;
}

export type InterruptReason = "play_now" | "base_cut_in";

export interface InterruptDecision {
  /** The player must load the next track now, without waiting for the current one to end. */
  interrupt: boolean;
  reason: InterruptReason | null;
  /**
   * A request is queued while a store song plays, but the store chose to let that
   * song finish. The player still has to cut in when the song never ends (a live
   * stream), so it re-checks this against the real playback position.
   */
  waitingOnBase: boolean;
}

/**
 * Decides whether the player should cut the current track off:
 *   - a verified "play now" donation always interrupts;
 *   - with interruptBaseOnRequest on, a queued request interrupts the store's own
 *     song (never another customer's request — those just queue behind it).
 */
export function resolvePlayerInterrupt(params: {
  queue: QueueItem[];
  currentRequestId?: string | null;
  currentSource?: "request" | "base" | null;
  interruptBaseOnRequest: boolean;
}): InterruptDecision {
  const ordered = orderQueue(params.queue);
  const currentId = params.currentRequestId ?? null;
  if (ordered.some((q) => q.playNow && q.id !== currentId)) {
    return { interrupt: true, reason: "play_now", waitingOnBase: false };
  }
  const requestWaitingOnBase = params.currentSource === "base" && ordered.length > 0;
  if (requestWaitingOnBase && params.interruptBaseOnRequest) {
    return { interrupt: true, reason: "base_cut_in", waitingOnBase: false };
  }
  return { interrupt: false, reason: null, waitingOnBase: requestWaitingOnBase };
}

/**
 * The position a new donation of `amount` would take in the upcoming queue.
 * Returns ONLY the position number — never the amounts of other donations.
 * A new donation always plays ahead of all non-donation requests, so its
 * position equals the count of verified donations with amount >= it, plus one.
 */
export function previewDonationPosition(amount: number, queue: QueueItem[]): number {
  const ahead = queue.filter(
    (q) => q.donationStatus === "verified" && q.donationAmount >= amount,
  ).length;
  return ahead + 1;
}

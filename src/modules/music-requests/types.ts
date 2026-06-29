export type MusicRequestStatus =
  | "pending"
  | "approved"
  | "played"
  | "rejected"
  | "skipped"
  | "expired";

export type MusicDecisionAction = "approve" | "reject" | "play" | "skip";

export type DonationStatus = "none" | "pending" | "verified" | "rejected";

export interface PlaylistTrack {
  videoId: string;
  title: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
}

export interface MusicPlayerSettings {
  storeId: string;
  organizationId: string;
  playerEnabled: boolean;
  autoApprove: boolean;
  donationEnabled: boolean;
  minDonation: number;
  maxDurationSeconds: number;
  basePlaylist: PlaylistTrack[];
  licensingAcknowledgedAt?: string;
  updatedAt: string;
}

export interface NowPlaying {
  storeId: string;
  musicRequestId?: string;
  source: "request" | "base";
  youtubeVideoId?: string;
  title?: string;
  durationSeconds?: number;
  startedAt: string;
}

/** Statuses surfaced to customers on the public QR queue. */
export type PublicMusicRequestStatus = Extract<
  MusicRequestStatus,
  "pending" | "approved" | "played"
>;

export const MUSIC_REQUEST_STATUS_LABEL: Record<MusicRequestStatus, string> = {
  pending: "รอคิว",
  approved: "อนุมัติแล้ว",
  played: "เปิดแล้ว",
  rejected: "ปฏิเสธ",
  skipped: "ข้าม",
  expired: "หมดอายุ",
};

export const MUSIC_DECISION_TO_STATUS: Record<MusicDecisionAction, MusicRequestStatus> = {
  approve: "approved",
  reject: "rejected",
  play: "played",
  skip: "skipped",
};

/** Public-safe view for the customer queue — never exposes internal fields. */
export interface PublicMusicRequest {
  id: string;
  songTitle: string;
  artistName?: string;
  requesterLabel?: string;
  status: PublicMusicRequestStatus;
  requestedAt: string;
}

/** Full view for the staff dashboard. */
export interface MusicRequest {
  id: string;
  storeId: string;
  organizationId: string;
  tableId?: string;
  tableNumber?: string;
  sessionId?: string;
  requesterLabel?: string;
  songTitle: string;
  artistName?: string;
  note?: string;
  status: MusicRequestStatus;
  donationStatus: DonationStatus;
  requestedAt: string;
  decidedAt?: string;
  decidedBy?: string;
  playedAt?: string;
}

export interface MusicRequestSubmitInput {
  songTitle: string;
  artistName?: string;
  requesterLabel?: string;
  note?: string;
}

export interface MusicRequestNormalized {
  songTitle: string;
  artistName?: string;
  requesterLabel?: string;
  note?: string;
}

export type MusicRequestInputError =
  | "song_required"
  | "song_too_long"
  | "artist_too_long"
  | "requester_too_long"
  | "note_too_long";

export const MUSIC_INPUT_ERROR_MESSAGE: Record<MusicRequestInputError, string> = {
  song_required: "กรุณากรอกชื่อเพลง",
  song_too_long: "ชื่อเพลงต้องไม่เกิน 120 ตัวอักษร",
  artist_too_long: "ชื่อศิลปินต้องไม่เกิน 120 ตัวอักษร",
  requester_too_long: "ชื่อผู้ขอต้องไม่เกิน 60 ตัวอักษร",
  note_too_long: "หมายเหตุต้องไม่เกิน 240 ตัวอักษร",
};

/** Mirrors the create_music_request RPC limits; validate before hitting the DB. */
export function validateMusicRequestInput(
  input: MusicRequestSubmitInput,
):
  | { ok: true; value: MusicRequestNormalized }
  | { ok: false; error: MusicRequestInputError } {
  const songTitle = (input.songTitle ?? "").trim();
  if (songTitle.length < 1) return { ok: false, error: "song_required" };
  if (songTitle.length > 120) return { ok: false, error: "song_too_long" };

  const artist = (input.artistName ?? "").trim();
  if (artist.length > 120) return { ok: false, error: "artist_too_long" };

  const requester = (input.requesterLabel ?? "").trim();
  if (requester.length > 60) return { ok: false, error: "requester_too_long" };

  const note = (input.note ?? "").trim();
  if (note.length > 240) return { ok: false, error: "note_too_long" };

  return {
    ok: true,
    value: {
      songTitle,
      artistName: artist || undefined,
      requesterLabel: requester || undefined,
      note: note || undefined,
    },
  };
}

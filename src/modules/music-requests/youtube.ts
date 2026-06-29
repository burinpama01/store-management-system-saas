const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;

/**
 * Extracts a YouTube video id from a watch URL, a youtu.be short URL, or a bare
 * 11-character id. Returns null for anything else.
 */
export function parseYouTubeVideoId(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  if (VIDEO_ID_RE.test(raw)) return raw;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return VIDEO_ID_RE.test(id) ? id : null;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    const v = url.searchParams.get("v");
    if (v && VIDEO_ID_RE.test(v)) return v;
    // /embed/<id> or /shorts/<id>
    const parts = url.pathname.split("/").filter(Boolean);
    if ((parts[0] === "embed" || parts[0] === "shorts") && VIDEO_ID_RE.test(parts[1] ?? "")) {
      return parts[1];
    }
  }
  return null;
}

/** Parse one YouTube URL/id per line into a deduped base playlist (max 100). */
export function parseBasePlaylist(raw: string): { videoId: string; title: string }[] {
  const seen = new Set<string>();
  const tracks: { videoId: string; title: string }[] = [];
  for (const line of (raw ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const videoId = parseYouTubeVideoId(trimmed);
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);
    tracks.push({ videoId, title: trimmed });
    if (tracks.length >= 100) break;
  }
  return tracks;
}

/** Parses an ISO-8601 duration (e.g. "PT3M20S") into seconds. */
export function parseIso8601Duration(iso: string): number | null {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? "");
  if (!m) return null;
  const [, h, min, s] = m;
  if (!h && !min && !s) return null;
  return Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0);
}

export interface YouTubeSearchResult {
  videoId: string;
  title: string;
  thumbnailUrl?: string;
  durationSeconds?: number;
  channelTitle?: string;
}

interface RawYouTubeVideo {
  id?: string;
  snippet?: {
    title?: string;
    channelTitle?: string;
    thumbnails?: { medium?: { url?: string }; default?: { url?: string } };
  };
  contentDetails?: { duration?: string };
  status?: { embeddable?: boolean };
}

/**
 * Pure: maps a YouTube videos.list response to playable results — drops
 * non-embeddable videos and anything longer than maxDurationSeconds.
 */
export function mapPlayableYouTubeVideos(
  items: RawYouTubeVideo[],
  maxDurationSeconds: number,
): YouTubeSearchResult[] {
  const out: YouTubeSearchResult[] = [];
  for (const it of items ?? []) {
    if (!it.id) continue;
    if (it.status?.embeddable === false) continue;
    const dur = it.contentDetails?.duration
      ? parseIso8601Duration(it.contentDetails.duration)
      : null;
    if (dur != null && dur > maxDurationSeconds) continue;
    out.push({
      videoId: it.id,
      title: it.snippet?.title ?? it.id,
      thumbnailUrl: it.snippet?.thumbnails?.medium?.url ?? it.snippet?.thumbnails?.default?.url,
      durationSeconds: dur ?? undefined,
      channelTitle: it.snippet?.channelTitle,
    });
  }
  return out;
}

/**
 * Searches YouTube (Data API v3) for embeddable videos within the duration cap.
 * The API key stays server-side. Returns a friendly error on quota/network fail.
 */
export async function searchYouTube(
  query: string,
  opts: { maxDurationSeconds?: number; limit?: number } = {},
): Promise<{ results: YouTubeSearchResult[]; error: string | null }> {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) return { results: [], error: "ยังไม่ได้ตั้งค่า YouTube API" };
  const q = (query ?? "").trim();
  if (!q) return { results: [], error: null };
  const maxDuration = opts.maxDurationSeconds ?? 600;
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 20);

  try {
    const searchUrl =
      `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video` +
      `&videoEmbeddable=true&maxResults=${limit}&q=${encodeURIComponent(q)}&key=${key}`;
    const sr = await fetch(searchUrl);
    if (!sr.ok) return { results: [], error: "ค้นหา YouTube ไม่สำเร็จ" };
    const sj = (await sr.json()) as { items?: { id?: { videoId?: string } }[] };
    const ids = (sj.items ?? [])
      .map((i) => i.id?.videoId)
      .filter((v): v is string => Boolean(v));
    if (ids.length === 0) return { results: [], error: null };

    const videosUrl =
      `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,status` +
      `&id=${ids.join(",")}&key=${key}`;
    const vr = await fetch(videosUrl);
    if (!vr.ok) return { results: [], error: "ค้นหา YouTube ไม่สำเร็จ" };
    const vj = (await vr.json()) as { items?: RawYouTubeVideo[] };
    return { results: mapPlayableYouTubeVideos(vj.items ?? [], maxDuration), error: null };
  } catch {
    return { results: [], error: "เชื่อมต่อ YouTube ไม่สำเร็จ" };
  }
}

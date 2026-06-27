import { NextRequest, NextResponse } from "next/server";

// Same-origin proxy for receipt logo/footer images. The raster receipt renderer
// draws these onto a <canvas> and reads pixels back with getImageData — which
// taints (and fails) on a cross-origin image. Serving the image from our own
// origin removes all CORS/cache/browser variance, so uploaded images reliably
// print on the IP / Print Hub raster path.

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/** SSRF guard: only proxy public objects from this project's Supabase storage. */
function resolveAllowedImageUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) return null;
  let base: URL;
  try {
    base = new URL(supabaseUrl);
  } catch {
    return null;
  }
  if (url.origin !== base.origin) return null;
  if (!url.pathname.startsWith("/storage/v1/object/public/")) return null;
  return url;
}

export async function GET(req: NextRequest) {
  const src = req.nextUrl.searchParams.get("src");
  if (!src) return NextResponse.json({ error: "Missing src" }, { status: 400 });

  const url = resolveAllowedImageUrl(src);
  if (!url) return NextResponse.json({ error: "Disallowed image source" }, { status: 400 });

  let upstream: Response;
  try {
    upstream = await fetch(url.toString(), { cache: "no-store" });
  } catch {
    return NextResponse.json({ error: "Upstream fetch failed" }, { status: 502 });
  }
  if (!upstream.ok) {
    return NextResponse.json({ error: "Upstream error" }, { status: 502 });
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) {
    return NextResponse.json({ error: "Not an image" }, { status: 415 });
  }

  const buffer = await upstream.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_IMAGE_BYTES) {
    return NextResponse.json({ error: "Image too large" }, { status: 413 });
  }

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=300",
    },
  });
}

// Lyra's eyes — full-page screenshot + page text via screenshotone.com.
// Matches api/chat.js convention (ESM default-export handler).
//
// Auth: x-lyra-key header must match LYRA_SCREENSHOT_SECRET env var.
// Screenshot: screenshotone /take, JPEG quality 80, 1280px viewport.
// Text/title: parallel native fetch(url) + HTML regex extraction.
// Response: { screenshot: base64JPEG | null, title, text }

const SCREENSHOTONE_ENDPOINT = "https://api.screenshotone.com/take";
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;
const SCREENSHOTONE_TIMEOUT_MS = 45000;
const HTML_FETCH_TIMEOUT_MS = 15000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_CHARS = 50000;
const REAL_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 ML11-Lyra";

function isPrivateHost(host) {
  const h = (host || "").toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h === "::1") return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (/^127\./.test(h)) return true;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (h === "metadata.google.internal") return true;
  return false;
}

function decodeEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function extractTitleAndText(html, fallbackTitle) {
  if (!html) return { title: fallbackTitle, text: "" };
  let title = "";
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) title = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
  if (!title) title = fallbackTitle;
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(br|\/p|\/h[1-6]|\/li|\/div|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (text.length > MAX_TEXT_CHARS) text = text.slice(0, MAX_TEXT_CHARS) + "\n\u2026[truncated]";
  return { title, text };
}

async function callScreenshotOne(url, apiKey) {
  const params = new URLSearchParams({
    access_key: apiKey,
    url,
    full_page: "true",
    format: "jpg",
    image_quality: "80",
    response_type: "by_format",
    viewport_width: String(VIEWPORT_WIDTH),
    viewport_height: String(VIEWPORT_HEIGHT),
  });

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), SCREENSHOTONE_TIMEOUT_MS);

  try {
    const r = await fetch(`${SCREENSHOTONE_ENDPOINT}?${params}`, {
      method: "GET",
      signal: ctl.signal,
    });

    const status = r.status;
    const ct = r.headers.get("content-type") || "";
    const cl = r.headers.get("content-length") || "";
    const loc = r.headers.get("location") || "";
    console.log(`[screenshot] screenshotone status=${status} ct=${ct} cl=${cl} loc=${loc}`);

    if (!r.ok) {
      let body = "";
      try { body = (await r.text()).slice(0, 600); } catch (_) {}
      throw new Error(`screenshotone HTTP ${status}: ${body || r.statusText}`);
    }

    if (!ct.toLowerCase().startsWith("image/")) {
      let body = "";
      try { body = (await r.text()).slice(0, 600); } catch (_) {}
      throw new Error(`screenshotone non-image content-type "${ct}". Body: ${body}`);
    }

    const ab = await r.arrayBuffer();
    const buf = Buffer.from(ab);
    console.log(`[screenshot] bytes read=${buf.length}`);

    if (buf.length === 0) {
      throw new Error("screenshotone returned 200 image/jpeg with 0-byte body");
    }

    return buf.toString("base64");
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHtml(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), HTML_FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": REAL_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: ctl.signal,
    });
    if (!r.ok) throw new Error(`html HTTP ${r.status}`);
    const reader = r.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_HTML_BYTES) { try { reader.cancel(); } catch (_) {} break; }
      chunks.push(value);
    }
    return Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sent = req.headers["x-lyra-key"];
  const expected = process.env.LYRA_SCREENSHOT_SECRET;
  if (!expected) return res.status(500).json({ error: "LYRA_SCREENSHOT_SECRET missing" });
  if (!sent || sent !== expected) return res.status(401).json({ error: "Unauthorized" });

  const apiKey = process.env.SCREENSHOTONE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "SCREENSHOTONE_API_KEY missing" });

  const { url } = req.body || {};
  if (!url || typeof url !== "string") return res.status(400).json({ error: "url required" });

  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: "Invalid URL" }); }
  if (!["http:", "https:"].includes(parsed.protocol)) return res.status(400).json({ error: "http(s) only" });
  if (isPrivateHost(parsed.hostname)) return res.status(400).json({ error: "Private addresses blocked" });

  const [shotResult, htmlResult] = await Promise.allSettled([
    callScreenshotOne(url, apiKey),
    fetchHtml(url),
  ]);

  let screenshot = null;
  if (shotResult.status === "fulfilled") {
    screenshot = shotResult.value;
  } else {
    console.warn("[screenshot] failed:", shotResult.reason?.message);
  }

  let title = parsed.hostname;
  let text = "";
  if (htmlResult.status === "fulfilled") {
    const ext = extractTitleAndText(htmlResult.value, parsed.hostname);
    title = ext.title;
    text = ext.text;
  } else {
    console.warn("[html] failed:", htmlResult.reason?.message);
  }

  return res.status(200).json({ screenshot, title, text });
}

export const config = { maxDuration: 60 };

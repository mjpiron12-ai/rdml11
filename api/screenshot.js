// Lyra's eyes — full-page screenshot + page text via screenshotone.com.
// Matches api/chat.js convention (ESM default-export handler).
//
// Auth: x-lyra-key header must match LYRA_SCREENSHOT_SECRET env var.
// Screenshot: screenshotone /take endpoint, JPEG quality 80, 1280px viewport.
// Text/title: parallel native fetch(url) + HTML regex extraction.
// Response: { screenshot: base64JPEG | null, title, text }
// Degradation: if screenshotone fails, screenshot is null but title/text
// still returned; status code stays 200 as long as one source succeeded.

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

async function fetchWithTimeout(url, opts, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
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
  if (text.length > MAX_TEXT_CHARS) {
    text = text.slice(0, MAX_TEXT_CHARS) + "\n\u2026[truncated]";
  }
  return { title, text };
}

async function callScreenshotOne(url, apiKey) {
  const params = new URLSearchParams({
    access_key: apiKey,
    url,
    full_page: "true",
    format: "jpg",
    image_quality: "80",
    viewport_width: String(VIEWPORT_WIDTH),
    viewport_height: String(VIEWPORT_HEIGHT),
    block_ads: "true",
    block_cookie_banners: "true",
    cache: "false",
  });
  const r = await fetchWithTimeout(
    `${SCREENSHOTONE_ENDPOINT}?${params}`,
    { method: "GET" },
    SCREENSHOTONE_TIMEOUT_MS
  );
  if (!r.ok) {
    let body = "";
    try { body = (await r.text()).slice(0, 400); } catch (_) {}
    throw new Error(`screenshotone ${r.status}: ${body || r.statusText}`);
  }
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.toString("base64");
}

async function fetchHtml(url) {
  const r = await fetchWithTimeout(
    url,
    {
      headers: {
        "User-Agent": REAL_UA,
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    },
    HTML_FETCH_TIMEOUT_MS
  );
  if (!r.ok) throw new Error(`html ${r.status} ${r.statusText}`);
  const reader = r.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_HTML_BYTES) {
      try { reader.cancel(); } catch (_) {}
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const sent = req.headers["x-lyra-key"];
  const expected = process.env.LYRA_SCREENSHOT_SECRET;
  if (!expected) {
    return res.status(500).json({ error: "Server misconfigured: LYRA_SCREENSHOT_SECRET missing" });
  }
  if (!sent || sent !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const apiKey = process.env.SCREENSHOTONE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "Server misconfigured: SCREENSHOTONE_API_KEY missing" });
  }

  const { url } = req.body || {};
  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "Body must include { url: string }" });
  }

  let parsed;
  try { parsed = new URL(url); }
  catch { return res.status(400).json({ error: "Invalid URL" }); }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    return res.status(400).json({ error: "Only http(s) URLs allowed" });
  }
  if (isPrivateHost(parsed.hostname)) {
    return res.status(400).json({ error: "Private/internal addresses are blocked" });
  }

  const [shotResult, htmlResult] = await Promise.allSettled([
    callScreenshotOne(url, apiKey),
    fetchHtml(url),
  ]);

  let screenshot = null;
  if (shotResult.status === "fulfilled") {
    screenshot = shotResult.value;
  } else {
    console.warn("[screenshot] screenshotone failed:", shotResult.reason?.message);
  }

  let title = parsed.hostname;
  let text = "";
  if (htmlResult.status === "fulfilled") {
    const ext = extractTitleAndText(htmlResult.value, parsed.hostname);
    title = ext.title;
    text = ext.text;
  } else {
    console.warn("[screenshot] html fetch failed:", htmlResult.reason?.message);
  }

  return res.status(200).json({ screenshot, title, text });
}

export const config = { maxDuration: 60 };

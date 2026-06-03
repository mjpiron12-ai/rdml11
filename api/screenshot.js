// Lyra's eyes — screenshotone.com backend with auth debug

const SCREENSHOTONE_ENDPOINT = "https://api.screenshotone.com/take";
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;
const MAX_TEXT_CHARS = 50000;
const REAL_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 ML11-Lyra";

function isPrivateHost(host) {
  const h = (host || "").toLowerCase();
  if (h === "localhost" || h === "0.0.0.0" || h === "::1") return true;
  if (h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)) return true;
  if (h === "metadata.google.internal") return true;
  return false;
}

function decodeEntities(s) {
  return String(s || "").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&quot;/g,'"').replace(/&nbsp;/g," ");
}

function extractTitleAndText(html, fallback) {
  if (!html) return { title: fallback, text: "" };
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  let title = m ? decodeEntities(m[1]).replace(/\s+/g," ").trim() : fallback;
  let text = html.replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<[^>]+>/g," ");
  text = decodeEntities(text).replace(/\s+/g," ").trim().slice(0, MAX_TEXT_CHARS);
  return { title, text };
}

async function callScreenshotOne(url, apiKey) {
  const params = new URLSearchParams({
    access_key: apiKey, url,
    full_page: "true", format: "jpg", image_quality: "80",
    response_type: "by_format",
    viewport_width: String(VIEWPORT_WIDTH), viewport_height: String(VIEWPORT_HEIGHT),
  });
  const r = await fetch(`${SCREENSHOTONE_ENDPOINT}?${params}`);
  const ct = r.headers.get("content-type") || "";
  if (!r.ok) { const b = await r.text(); throw new Error(`screenshotone ${r.status}: ${b.slice(0,400)}`); }
  if (!ct.startsWith("image/")) { const b = await r.text(); throw new Error(`non-image: ${b.slice(0,400)}`); }
  const buf = Buffer.from(await r.arrayBuffer());
  return buf.toString("base64");
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow","POST"); return res.status(405).json({error:"Method not allowed"}); }

  const sent = req.headers["x-lyra-key"];
  const expected = process.env.LYRA_SCREENSHOT_SECRET;
  
  // Debug: log first 8 chars of both so we can compare
  console.log(`[auth] expected_start="${(expected||"").slice(0,8)}" sent_start="${(sent||"").slice(0,8)}" expected_len=${(expected||"").length} sent_len=${(sent||"").length}`);

  if (!expected) return res.status(500).json({ error: "LYRA_SCREENSHOT_SECRET missing" });
  if (!sent || sent !== expected) return res.status(401).json({ 
    error: "Unauthorized",
    debug: { expected_start: (expected||"").slice(0,8), sent_start: (sent||"").slice(0,8), expected_len: (expected||"").length, sent_len: (sent||"").length }
  });

  const apiKey = process.env.SCREENSHOTONE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "SCREENSHOTONE_API_KEY missing" });

  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "url required" });

  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: "Invalid URL" }); }
  if (!["http:","https:"].includes(parsed.protocol)) return res.status(400).json({ error: "http(s) only" });
  if (isPrivateHost(parsed.hostname)) return res.status(400).json({ error: "Private addresses blocked" });

  const [shotResult, htmlResult] = await Promise.allSettled([
    callScreenshotOne(url, apiKey),
    fetch(url, { headers: { "User-Agent": REAL_UA } }).then(r => r.text()),
  ]);

  const screenshot = shotResult.status === "fulfilled" ? shotResult.value : null;
  if (shotResult.status === "rejected") console.warn("[screenshot] failed:", shotResult.reason?.message);

  let title = parsed.hostname, text = "";
  if (htmlResult.status === "fulfilled") {
    const ext = extractTitleAndText(htmlResult.value, parsed.hostname);
    title = ext.title; text = ext.text;
  }

  return res.status(200).json({ screenshot, title, text });
}

export const config = { maxDuration: 60 };

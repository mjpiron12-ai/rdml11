// Lyra's eyes — full-page screenshot + page text via headless Chromium.
// Matches api/chat.js convention (ESM default-export handler).
//
// Stack: puppeteer-core + @sparticuz/chromium-min (Vercel Hobby-safe).
// Auth: x-lyra-key header must match LYRA_SCREENSHOT_SECRET env var.
// Response: { screenshot: base64JPEG (quality 80), title, text }
//
// Cold-start: ~5-10s on first call (chromium binary download).
// Subsequent calls reuse the extracted /tmp copy until container recycles.

import chromium from "@sparticuz/chromium-min";
import puppeteer from "puppeteer-core";

// Pin chromium major to match @sparticuz/chromium-min in package.json.
// Self-host this binary to R2/S3 long-term — GitHub raw can throttle.
const CHROMIUM_PACK_URL =
  "https://github.com/Sparticuz/chromium/releases/download/v131.0.1/chromium-v131.0.1-pack.tar";

// SSRF guard — block private/internal addresses.
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Shared-secret auth.
  const sent = req.headers["x-lyra-key"];
  const expected = process.env.LYRA_SCREENSHOT_SECRET;
  if (!expected) {
    return res.status(500).json({ error: "Server misconfigured: LYRA_SCREENSHOT_SECRET missing" });
  }
  if (!sent || sent !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
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

  let browser;
  try {
    browser = await puppeteer.launch({
      args: [...chromium.args, "--hide-scrollbars"],
      defaultViewport: { width: 1280, height: 800, deviceScaleFactor: 1 },
      executablePath: await chromium.executablePath(CHROMIUM_PACK_URL),
      headless: chromium.headless,
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 ML11-Lyra"
    );

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    const [screenshotBuf, title, text] = await Promise.all([
      page.screenshot({ type: "jpeg", quality: 80, fullPage: true }),
      page.title(),
      page.evaluate(() => (document.body && document.body.innerText) || ""),
    ]);

    const trimmedText = text.length > 50000
      ? text.slice(0, 50000) + "\n…[truncated]"
      : text;

    return res.status(200).json({
      screenshot: screenshotBuf.toString("base64"),
      title,
      text: trimmedText,
    });
  } catch (e) {
    return res.status(500).json({
      error: (e && e.message) ? e.message : "Screenshot failed",
    });
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
}

export const config = { maxDuration: 60 };

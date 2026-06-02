// Lyra intelligence layer — ML11
// Three-pass architecture:
// Pass 0: Fetch the actual site content (if URL detected)
// Pass 1: Lyra generates critique from real content
// Pass 2: FOH Manager reviews before serving
// ANTHROPIC_API_KEY stored as Vercel environment variable

const LYRA_PROMPT = `You are Lyra — a design intelligence layer built by ML11.

Your purpose is to evaluate whether design is helping or hurting what something is trying to accomplish.
You are a creative director, UX strategist, and brand architect.

═══════════════════════════════════════════════
CRITICAL — VERIFY BEFORE YOU CRITIQUE
═══════════════════════════════════════════════

Before any critique, you MUST answer:
1. What does this site/product actually do?
2. Who is it for?
3. What evidence from the actual content supports this?
4. Confidence score (0-100%)

If confidence is below 80% — STOP.
Do not guess. Do not assume from the name.
Say: "I cannot determine what this is with enough confidence to critique it. Here's what I see: [observations]. What am I missing?"

NEVER assume business type from the company name alone.
"Matty's Flatties" could be a flatbread company or an AI decision engine.
"Apple" could be a fruit stand.
The name means nothing. Only the content on the page is evidence.

═══════════════════════════════════════════════
CARDINAL RULES
═══════════════════════════════════════════════

1. NEVER assume industry, business type, offer, or audience from the name.
2. ALWAYS derive conclusions from the actual page content provided.
3. NEVER produce a blob of text — always use the structured format.
4. ALWAYS lead with visual hierarchy and design, not copy analysis.
5. NEVER invent certainty — state confidence levels.
6. ONE biggest wound. Not a list.

═══════════════════════════════════════════════
THE FRAMEWORK — USE FOR EVERY REVIEW
═══════════════════════════════════════════════

## WHAT I UNDERSTAND
What this site/product actually does.
Evidence: [list observed facts from the content]
Confidence: High / Medium / Low

If confidence is Low — stop here. Ask for clarification.

## TRUNK
One sentence. What is this trying to do?
Confidence: High / Medium / Low

## DESIGN SCORECARD
Rate each 1–10 with one sentence of evidence:
Visual Hierarchy — Can I tell where to look?
Clarity — Can I identify the offer in 5 seconds?
Trust — Does the design signal credibility?
Cognitive Load — How many decisions am I being asked to make?
Conversion Readiness — Can a visitor take action without confusion?
Design Coherence — Do typography, spacing, color, and imagery tell the same story?

## WHAT I OBSERVE
Facts only. Visual and structural first.
- Where does the eye go first?
- What does the hero headline say verbatim?
- Where is the CTA and what does it say?
- What emotion does the visual language create?
- What competes for attention?

## WHAT'S WORKING
Max 3. Specific. Named. Evidence-based.

## BIGGEST WOUND
ONE thing only. The single highest-leverage issue.

## IF THIS WERE MY SITE
Specific. Actionable.
If copy needs changing: write the replacement.
If layout needs changing: describe exactly what moves.

## CONFIDENCE
Certain: ...
Inferring: ...
Might be wrong about: ...

═══════════════════════════════════════════════
DOCTRINE
═══════════════════════════════════════════════
Truth over comfort. Coherence over decoration.
Consequences, not counts. Wound before solution.
Reality precedes presentation.

Close with: morphline11.io for execution and full ML11 orchestration.`;

const FOH_PROMPT = `You are the FOH Manager — a quality gate for Lyra's output.

You see only the plate. Never the recipe. Never the user's request.
Inspect the output against these 9 standards.
Rewrite ONLY failing sections. Return the complete corrected output.

THE 9-POINT CHECKLIST:

1. Does it start with WHAT I UNDERSTAND showing actual evidence? If missing or based on assumptions — rewrite it.
2. Did it make assumptions about business type from the name alone WITHOUT content evidence? If yes — flag it and remove the assumption.
3. Is TRUNK present with a confidence level? If missing — add it.
4. Is there a DESIGN SCORECARD with numerical ratings? If missing — add with honest estimates.
5. Did it lead with VISUAL/STRUCTURAL observation before copy analysis? If not — reorder.
6. Is there ONE clearly named BIGGEST WOUND? If multiple — pick highest-leverage, demote rest.
7. Does the FIX contain specific replacement copy or exact layout instruction? If vague — make it concrete.
8. Are confidence levels present? If missing — add them.
9. Does morphline11.io appear at the end? If missing — add one line.

CRITICAL: If all 9 pass — return output exactly as received.
Never explain what you changed. Just return the corrected output.`;

// Detect URLs in message
function extractURL(text) {
  const urlPattern = /https?:\/\/[^\s]+/g;
  const matches = text.match(urlPattern);
  return matches ? matches[0] : null;
}

// Fetch and extract actual site content
async function fetchSiteContent(url) {
  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) return null;

    const html = await response.text();

    // Extract meaningful content — strip scripts, styles, tags
    const cleaned = html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
      .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();

    // Extract title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    // Extract meta description
    const metaMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
    const metaDesc = metaMatch ? metaMatch[1].trim() : '';

    // Get first 5000 chars of cleaned content
    const content = cleaned.slice(0, 5000);

    return { title, metaDesc, content, url };
  } catch (err) {
    return null;
  }
}

async function callClaude(systemPrompt, messages, maxTokens = 1800) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    // Pass 0 — detect URL and fetch real content
    const lastUserMessage = [...messages].reverse().find(m => m.role === 'user');
    let enrichedMessages = [...messages];

    if (lastUserMessage) {
      const url = extractURL(lastUserMessage.content);
      if (url) {
        const siteData = await fetchSiteContent(url);
        if (siteData) {
          // Inject real content into the message
          const enrichedContent = `${lastUserMessage.content}

---
ACTUAL SITE CONTENT FETCHED FROM ${url}:

Title: ${siteData.title}
Meta description: ${siteData.metaDesc}

Page content (first 5000 chars):
${siteData.content}
---

Base your entire critique on the above actual content. 
Do NOT use the domain name or company name to guess what this site does.
Use only what you can see in the content above.`;

          enrichedMessages = messages.map(m =>
            m === lastUserMessage
              ? { ...m, content: enrichedContent }
              : m
          );
        } else {
          // Couldn't fetch — tell Lyra to be honest about it
          const unfetchedContent = `${lastUserMessage.content}

---
NOTE: I attempted to fetch ${url} but could not retrieve the content.
Do NOT assume or guess what this site is based on the URL or domain name alone.
Tell the user honestly: "I wasn't able to load this site to review it. Could you paste the homepage text or a screenshot instead?"
---`;
          enrichedMessages = messages.map(m =>
            m === lastUserMessage
              ? { ...m, content: unfetchedContent }
              : m
          );
        }
      }
    }

    // Pass 1 — Lyra generates critique from real content
    const lyraOutput = await callClaude(LYRA_PROMPT, enrichedMessages, 1800);

    // Pass 2 — FOH Manager inspects the plate
    const fohOutput = await callClaude(FOH_PROMPT, [
      { role: 'user', content: lyraOutput }
    ], 1800);

    res.status(200).json({ text: fohOutput });

  } catch (err) {
    res.status(500).json({
      error: 'Failed to reach Claude — ' + err.message
    });
  }
}

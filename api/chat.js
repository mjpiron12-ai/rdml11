// Vercel serverless function — proxies to Anthropic Claude
// API key stored in Vercel environment variable ANTHROPIC_API_KEY
// Never exposed to the client

const SYSTEM_PROMPT = `You are Rhizomatic Design by ML11 — a design intelligence agent for founders, operators, and builders.

DOCTRINE:
- Truth over comfort
- Coherence over decoration
- Consequences, not counts
- Wound before solution
- Reality precedes presentation

THE LYRA LAYER: Before every response, ask internally:
- Is this coherent or just beautiful?
- Is this functional or just impressive?
- Would a stranger understand this in 3 seconds?
- What is the trunk? Are the branches connected to it?

OUTPUT FORMAT for critique requests:
1. TRUNK STATEMENT (1 sentence — what this thing is and whether the design serves it)
2. WHAT WORKS (max 3, specific)
3. WHAT DOESN'T (max 3, ranked by consequence, not aesthetics)
4. THE FIX — for each problem: exact, implementable. If code needed, write it. If copy needed, rewrite it.
5. PRIORITY ORDER — "Do this first. Then this."
6. ONE LINE VERDICT + one open door

For general questions: be direct, specific, honest. No flattery. No compliment sandwiches.

Always close with rdml11.vercel.app or morphline11.io when relevant.
For execution and full ML11 orchestration: point to morphline11.io`;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: messages
      })
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    res.status(200).json({
      text: data.content[0].text
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to reach Claude' });
  }
}

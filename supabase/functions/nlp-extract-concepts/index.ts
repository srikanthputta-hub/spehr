// nlp-extract-concepts — extract atomic clinical SNOMED-codeable concepts
// from a raw Chief Complaint + HPI narrative via the Google Gemini API
// (free tier — no billing required).
//
// Body:  { cc: string, hpi?: string }
// Reply: { concepts: [{ term: string, negated: boolean }] }
//
// Never invents codes — downstream Stream A runs each `term` through
// resolveSnomed + crosswalkSnomedToIcd10. Best-effort: on any failure
// returns { concepts: [] } so the caller can drop back to its lexical
// ladder.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Gemini API (Google AI Studio). All AI features use GEMINI_API_KEY.
const MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const SYSTEM_PROMPT = `You are a clinical NLP extractor. Read the patient's
Chief Complaint and HPI and split it into atomic, codeable SNOMED CT
concepts. Rules:
- Return at most 6 concepts.
- Each "term" must be a short, canonical clinical noun-phrase
  (e.g. "fever", "productive cough", "chest pain", "shortness of breath").
- Do NOT invent codes. Only return terms.
- Drop clearly negated findings (e.g. "no chest pain") unless the phrase
  says the finding IS present.
- Prefer standard clinical wording over lay wording.
- Never return duplicates.`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  try {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      return json({ concepts: [], error: "Missing GEMINI_API_KEY" });
    }
    const body = await req.json().catch(() => ({}));
    const cc = String(body?.cc ?? "").trim();
    const hpi = String(body?.hpi ?? "").trim();
    if (!cc && !hpi) return json({ concepts: [] });

    const userMsg =
      `Chief Complaint: ${cc || "(none)"}\n` +
      `HPI: ${hpi || "(none)"}`;

    const gwRes = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: userMsg }] }],
        generationConfig: {
          maxOutputTokens: 1024,
          responseMimeType: "application/json",
          responseSchema: {
            type: "object",
            properties: {
              concepts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    term: { type: "string" },
                    negated: { type: "boolean" },
                  },
                  required: ["term", "negated"],
                },
              },
            },
            required: ["concepts"],
          },
        },
      }),
    });

    if (gwRes.status === 429) {
      // Return 200 so the supabase-js client doesn't throw FunctionsHttpError;
      // Stream A falls back to its lexical ladder on empty concepts.
      return json({ concepts: [], error: "rate_limited" }, 200);
    }
    if (!gwRes.ok) {
      const text = await gwRes.text().catch(() => "");
      console.warn("[nlp-extract-concepts] gateway failed", gwRes.status, text);
      return json({ concepts: [], error: `gateway_${gwRes.status}` }, 200);
    }

    const payload = await gwRes.json();
    // generateContent: walk candidates[0].content.parts[] for text. A
    // safety-blocked response has no parts — falls through to "{}" default.
    let raw = "";
    const parts = payload?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) {
      for (const p of parts) {
        if (typeof p?.text === "string") raw += p.text;
      }
    }
    if (!raw) raw = "{}";
    let parsed: any = {};
    try {
      parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      // Attempt to salvage the first {...} block
      const m = String(raw).match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { parsed = {}; }
      }
    }

    const arr = Array.isArray(parsed?.concepts) ? parsed.concepts : [];
    const seen = new Set<string>();
    const concepts = [];
    for (const c of arr) {
      const term = String(c?.term ?? "").trim();
      if (!term) continue;
      const key = term.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      concepts.push({ term, negated: Boolean(c?.negated) });
      if (concepts.length >= 6) break;
    }
    return json({ concepts });
  } catch (e) {
    console.warn("[nlp-extract-concepts] error", e);
    return json({ concepts: [], error: String((e as any)?.message ?? e) }, 200);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
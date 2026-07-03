// nlp-extract-concepts — extract atomic clinical SNOMED-codeable concepts
// from a raw Chief Complaint + HPI narrative using the Lovable AI Gateway.
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

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
const MODEL = "google/gemini-2.5-flash";

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
    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) {
      return json({ concepts: [], error: "Missing LOVABLE_API_KEY" }, 500);
    }
    const body = await req.json().catch(() => ({}));
    const cc = String(body?.cc ?? "").trim();
    const hpi = String(body?.hpi ?? "").trim();
    if (!cc && !hpi) return json({ concepts: [] });

    const userMsg =
      `Chief Complaint: ${cc || "(none)"}\n` +
      `HPI: ${hpi || "(none)"}\n\n` +
      `Return JSON only in the shape {"concepts":[{"term":string,"negated":boolean}]}.`;

    const gwRes = await fetch(GATEWAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMsg },
        ],
        response_format: { type: "json_object" },
        temperature: 0.1,
      }),
    });

    if (gwRes.status === 429) {
      return json({ concepts: [], error: "rate_limited" }, 429);
    }
    if (gwRes.status === 402) {
      return json({ concepts: [], error: "credits_exhausted" }, 402);
    }
    if (!gwRes.ok) {
      const text = await gwRes.text().catch(() => "");
      console.warn("[nlp-extract-concepts] gateway failed", gwRes.status, text);
      return json({ concepts: [], error: `gateway_${gwRes.status}` }, 200);
    }

    const payload = await gwRes.json();
    const raw = payload?.choices?.[0]?.message?.content ?? "{}";
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
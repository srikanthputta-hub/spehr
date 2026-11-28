import { describe, expect, it } from "vitest";
import {
  VsacError,
  contentHash,
  createVsacClient,
  flattenContains,
  parseRetryAfterMs,
  type VsacClientOptions,
} from "../../supabase/functions/_shared/vsac-client";

/**
 * Tests for the VSAC FHIR client. No network: every response is a scripted
 * `Response`. The clock is fake and advances only through `sleep`, so the
 * throttle, Retry-After and backoff behaviour is asserted exactly.
 */

const KEY = "test-umls-key-123";
const OID = "2.16.840.1.113883.3.464.1003.101.12.1001";
const SNOMED = "http://snomed.info/sct";
const RXNORM = "http://www.nlm.nih.gov/research/umls/rxnorm";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function harness(handler: Handler, extra: Partial<VsacClientOptions> = {}) {
  let t = 1_700_000_000_000;
  const sleeps: number[] = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  const client = createVsacClient({
    apiKey: KEY,
    fetchImpl,
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    random: () => 0,
    ...extra,
  });
  return { client, calls, sleeps };
}

const definition = (over: Record<string, unknown> = {}) => ({
  resourceType: "ValueSet",
  id: OID,
  name: "EssentialHypertension",
  title: "Essential Hypertension",
  status: "active",
  version: "20240601",
  publisher: "NCQA",
  date: "2024-06-01",
  meta: { lastUpdated: "2024-06-02T00:00:00Z", versionId: "7" },
  compose: { include: [{ system: SNOMED, concept: [{ code: "38341003" }] }] },
  ...over,
});

const expansion = (contains: unknown[], over: Record<string, unknown> = {}) => ({
  resourceType: "ValueSet",
  id: OID,
  name: "EssentialHypertension",
  version: "20240601",
  status: "active",
  expansion: {
    timestamp: "2024-06-03T10:00:00Z",
    identifier: "urn:uuid:exp-1",
    total: contains.length,
    parameter: [{ name: "used-codesystem", valueUri: `${SNOMED}|20240301` }],
    contains,
    ...over,
  },
});

/** Routes definition vs $expand requests to separate handlers. */
function route(onExpand: (url: string) => Response, def: unknown = definition()): Handler {
  return (url) => (url.includes("/$expand") ? onExpand(url) : json(def));
}

describe("parseRetryAfterMs", () => {
  it("reads delta-seconds, HTTP-dates, and rejects junk", () => {
    expect(parseRetryAfterMs("3", 0)).toBe(3000);
    expect(parseRetryAfterMs(null, 0)).toBeNull();
    expect(parseRetryAfterMs("soon", 0)).toBeNull();
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(10_000);
  });
});

describe("contentHash / flattenContains", () => {
  it("hashes content independent of order and display text", async () => {
    const a = await contentHash([
      { system: SNOMED, code: "1" },
      { system: SNOMED, code: "2" },
    ]);
    const b = await contentHash([
      { system: SNOMED, code: "2" },
      { system: SNOMED, code: "1" },
    ]);
    const c = await contentHash([{ system: SNOMED, code: "1" }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("flattens nested contains", () => {
    const flat = flattenContains([
      { code: "a", contains: [{ code: "b", contains: [{ code: "c" }] }] },
    ]);
    expect(flat.map((e) => e.code)).toEqual(["a", "b", "c"]);
  });
});

describe("auth + transport", () => {
  it("sends Basic apikey:<key> in the header and never in the URL", async () => {
    const { client, calls } = harness(() => json({ resourceType: "Bundle", entry: [] }));
    await client.search("hypertension", 5);
    expect(calls[0].url).not.toContain(KEY);
    const auth = (calls[0].init?.headers as Record<string, string>).Authorization;
    expect(auth).toBe(`Basic ${btoa(`apikey:${KEY}`)}`);
  });

  it("refuses to be built without a key", () => {
    expect(() => createVsacClient({ apiKey: "" })).toThrow(VsacError);
  });

  it("self-throttles: a second request waits out the minimum interval", async () => {
    const { client, sleeps } = harness(() => json({ resourceType: "Bundle", entry: [] }), {
      minIntervalMs: 150,
    });
    await client.search("a", 5);
    await client.search("b", 5);
    expect(sleeps).toEqual([150]);
  });

  it("stops at the request budget", async () => {
    const { client } = harness(() => json({ resourceType: "Bundle", entry: [] }), {
      requestBudget: 2,
    });
    await client.search("a", 5);
    await client.search("b", 5);
    await expect(client.search("c", 5)).rejects.toMatchObject({ kind: "budget_exhausted" });
  });

  it("401 is fatal: classified auth, no retry, and the breaker blocks later calls", async () => {
    const { client, calls } = harness(() => json({}, 401));
    await expect(client.search("a", 5)).rejects.toMatchObject({ kind: "auth", status: 401 });
    expect(calls).toHaveLength(1);
    await expect(client.search("b", 5)).rejects.toMatchObject({ kind: "circuit_open" });
    expect(calls).toHaveLength(1); // second call never reached the network
    expect(client.stats().circuit).toBe("auth");
  });

  it("404 is a per-OID verdict: no retry and the breaker stays closed", async () => {
    const { client, calls } = harness(() => json({}, 404));
    await expect(client.retrieve(OID)).rejects.toMatchObject({ kind: "not_found" });
    expect(calls).toHaveLength(1);
    expect(client.stats().circuit).toBeNull();
  });

  it("429 honours a short Retry-After, then succeeds", async () => {
    let n = 0;
    const { client, sleeps } = harness(() =>
      ++n === 1
        ? json({}, 429, { "retry-after": "2" })
        : json({ resourceType: "Bundle", entry: [] }),
    );
    await expect(client.search("a", 5)).resolves.toEqual([]);
    expect(sleeps).toContain(2000);
  });

  it("429 with a Retry-After beyond the cap surfaces rate_limited and opens the breaker", async () => {
    const { client } = harness(() => json({}, 429, { "retry-after": "600" }), {
      maxRetryAfterMs: 15_000,
    });
    await expect(client.search("a", 5)).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 600_000,
    });
    await expect(client.search("b", 5)).rejects.toMatchObject({ kind: "circuit_open" });
  });

  it("retries 5xx with exponential backoff, then succeeds", async () => {
    let n = 0;
    const { client, sleeps, calls } = harness(() =>
      ++n <= 2 ? json({}, 503) : json({ resourceType: "Bundle", entry: [] }),
    );
    await expect(client.search("a", 5)).resolves.toEqual([]);
    expect(calls).toHaveLength(3);
    // first call has no throttle wait; then backoff 500ms, 1000ms (random() = 0 → no jitter)
    expect(sleeps.filter((s) => s >= 500)).toEqual([500, 1000]);
    expect(client.stats().retries).toBe(2);
  });

  it("gives up on persistent 5xx as transient", async () => {
    const { client, calls } = harness(() => json({}, 500));
    await expect(client.search("a", 5)).rejects.toMatchObject({ kind: "transient" });
    expect(calls).toHaveLength(3); // 1 + maxRetries(2)
  });

  it("treats a network failure as transient and never leaks the key in the message", async () => {
    const { client } = harness(() => {
      throw new Error(`connect failed to https://x?apiKey=${KEY}`);
    });
    const err = await client.search("a", 5).catch((e) => e);
    expect(err).toBeInstanceOf(VsacError);
    expect((err as VsacError).kind).toBe("transient");
    expect((err as VsacError).message).not.toContain(KEY);
  });

  it("a 400 is the request's fault: bad_request, no retry", async () => {
    const { client, calls } = harness(() => json({}, 400));
    await expect(client.search("a", 5)).rejects.toMatchObject({ kind: "bad_request" });
    expect(calls).toHaveLength(1);
  });
});

describe("search", () => {
  it("parses a Bundle, dedupes by OID, and clamps _count", async () => {
    const { client, calls } = harness(() =>
      json({
        resourceType: "Bundle",
        entry: [
          {
            resource: {
              id: "1.2.3",
              name: "A",
              title: "Alpha",
              publisher: "NCQA",
              status: "active",
              version: "v1",
            },
          },
          { resource: { id: "1.2.3", name: "dup" } },
          { resource: { name: "no id" } },
          { resource: { id: "4.5.6", status: "retired" } },
        ],
      }),
    );
    const out = await client.search("  hypertension ", 999);
    expect(out).toEqual([
      {
        oid: "1.2.3",
        name: "A",
        title: "Alpha",
        publisher: "NCQA",
        status: "active",
        version: "v1",
      },
      { oid: "4.5.6", name: null, title: null, publisher: null, status: "retired", version: null },
    ]);
    expect(calls[0].url).toContain("name%3Acontains=hypertension");
    expect(calls[0].url).toContain("_count=50");
  });

  it("returns [] for an empty query without calling VSAC", async () => {
    const { client, calls } = harness(() => json({}));
    expect(await client.search("   ", 5)).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe("retrieve — provenance, content, completeness", () => {
  const contains = [
    { system: SNOMED, code: "38341003", display: "Hypertensive disorder" },
    { system: SNOMED, code: "59621000", display: "Essential hypertension", inactive: true },
    { system: RXNORM, code: "197361", display: "amlodipine" },
    { system: SNOMED, code: "999", display: "Abstract grouper", abstract: true },
  ];

  it("copies VSAC's metadata verbatim and computes only retrieved_at + hash", async () => {
    const { client } = harness(route(() => json(expansion(contains))));
    const r = await client.retrieve(OID);
    const p = r.provenance;
    expect(p).toMatchObject({
      source: "VSAC",
      oid: OID,
      vsac_version: "20240601",
      vsac_status: "active",
      vsac_publisher: "NCQA",
      vsac_date: "2024-06-01",
      vsac_last_updated: "2024-06-02T00:00:00Z",
      vsac_version_id: "7",
      expansion_timestamp: "2024-06-03T10:00:00Z",
      expansion_identifier: "urn:uuid:exp-1",
      expansion_parameters: [{ name: "used-codesystem", valueUri: `${SNOMED}|20240301` }],
      total_reported: 4,
      codes_retrieved: 3,
      inactive_count: 1,
      abstract_excluded: 1,
      completeness: "verified",
      pages: 1,
    });
    expect(p.source_url).toBe(`https://cts.nlm.nih.gov/fhir/ValueSet/${OID}/$expand`);
    // Our clock, not VSAC's: the fake clock is 150ms on (the throttle gap between the
    // definition request and the $expand request) when the expansion finishes.
    expect(p.retrieved_at).toBe(new Date(1_700_000_000_000 + 150).toISOString());
    expect(p.content_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.attribution).toContain("National Library of Medicine");
    expect(p.code_systems).toEqual([
      { system: SNOMED, vocabulary: "SNOMED CT", count: 2 },
      { system: RXNORM, vocabulary: "RxNorm", count: 1 },
    ]);
  });

  it("excludes abstract entries, keeps inactive ones, and labels vocabularies", async () => {
    const { client } = harness(route(() => json(expansion(contains))));
    const r = await client.retrieve(OID);
    expect(r.codes.map((c) => c.code)).toEqual(["38341003", "59621000", "197361"]);
    expect(r.codes[1].inactive).toBe(true);
    expect(r.codes[0]).toMatchObject({ vocabulary: "SNOMED CT", system: SNOMED });
    expect(r.codes[2].vocabulary).toBe("RxNorm");
    expect(r.total).toBe(3);
  });

  it("keeps an unmapped code-system URI as-is rather than guessing a label", async () => {
    const { client } = harness(
      route(() =>
        json(expansion([{ system: "http://example.org/mystery", code: "X1", display: "x" }])),
      ),
    );
    const r = await client.retrieve(OID);
    expect(r.codes[0].vocabulary).toBe("http://example.org/mystery");
  });

  it("detects authoring type from compose", async () => {
    const grouping = harness(
      route(
        () => json(expansion([{ system: SNOMED, code: "1", display: "a" }])),
        definition({ compose: { include: [{ valueSet: ["x"] }] } }),
      ),
    );
    expect((await grouping.client.retrieve(OID)).type).toBe("grouping");
    const intensional = harness(
      route(
        () => json(expansion([{ system: SNOMED, code: "1", display: "a" }])),
        definition({ compose: { include: [{ system: SNOMED, filter: [{}] }] } }),
      ),
    );
    expect((await intensional.client.retrieve(OID)).type).toBe("intensional");
    const extensional = harness(
      route(() => json(expansion([{ system: SNOMED, code: "1", display: "a" }]))),
    );
    expect((await extensional.client.retrieve(OID)).type).toBe("extensional");
  });

  it("reports null — never a guess — for metadata VSAC did not send", async () => {
    const bare = {
      resourceType: "ValueSet",
      expansion: { total: 1, contains: [{ system: SNOMED, code: "1", display: "a" }] },
    };
    const { client } = harness(route(() => json(bare), { resourceType: "ValueSet" }));
    const p = (await client.retrieve(OID)).provenance;
    expect(p.vsac_version).toBeNull();
    expect(p.vsac_publisher).toBeNull();
    expect(p.expansion_timestamp).toBeNull();
    expect(p.expansion_parameters).toBeNull();
    expect(p.vsac_last_updated).toBeNull();
  });

  it("pages through a server that honours offset/count and reassembles everything", async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({
      system: SNOMED,
      code: String(100 + i),
      display: `c${i}`,
    }));
    const { client, calls } = harness(
      route((url) => {
        const u = new URL(url);
        const off = Number(u.searchParams.get("offset") ?? 0);
        const cnt = Number(u.searchParams.get("count") ?? 999);
        const res = expansion(all.slice(off, off + cnt));
        (res.expansion as { total: number }).total = all.length;
        return json(res);
      }),
      { pageSize: 2 },
    );
    const r = await client.retrieve(OID);
    expect(r.codes.map((c) => c.code)).toEqual(["100", "101", "102", "103", "104"]);
    expect(r.provenance.pages).toBe(3);
    expect(calls.filter((c) => c.url.includes("$expand"))).toHaveLength(3);
  });

  it("REFUSES a truncated expansion: server ignores offset, total says there is more", async () => {
    const page = Array.from({ length: 2 }, (_, i) => ({
      system: SNOMED,
      code: String(i),
      display: "x",
    }));
    const { client } = harness(
      route(() => {
        const res = expansion(page);
        (res.expansion as { total: number }).total = 50; // claims 50, only ever serves the same 2
        return json(res);
      }),
      { pageSize: 2 },
    );
    await expect(client.retrieve(OID)).rejects.toMatchObject({ kind: "incomplete" });
  });

  it("falls back to an un-paged request when VSAC rejects paging params, and accepts it when whole", async () => {
    const all = [
      { system: SNOMED, code: "1", display: "a" },
      { system: SNOMED, code: "2", display: "b" },
    ];
    const { client, calls } = harness(
      route((url) => (url.includes("offset=") ? json({}, 400) : json(expansion(all)))),
    );
    const r = await client.retrieve(OID);
    expect(r.codes).toHaveLength(2);
    const expands = calls.filter((c) => c.url.includes("$expand"));
    expect(expands[0].url).toContain("offset=0");
    expect(expands[1].url).not.toContain("offset=");
  });

  it("with no reported total nothing is provable, so the expansion is refused — short page or full", async () => {
    const mk = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ system: SNOMED, code: `c${i}`, display: "x" }));
    const noTotal = (contains: unknown[]) => {
      const res = expansion(contains);
      delete (res.expansion as Record<string, unknown>).total;
      return res;
    };
    for (const n of [3, 10]) {
      const h = harness(
        route(() => json(noTotal(mk(n)))),
        { pageSize: 10 },
      );
      await expect(h.client.retrieve(OID)).rejects.toMatchObject({ kind: "incomplete" });
    }
  });

  it("a server that silently caps its page size and sends no total is refused, not staged as complete", async () => {
    // Asked for count=1000, serves its own 500 — indistinguishable from a whole set without a total.
    const res = expansion(
      Array.from({ length: 500 }, (_, i) => ({ system: SNOMED, code: `c${i}`, display: "x" })),
    );
    delete (res.expansion as Record<string, unknown>).total;
    const h = harness(
      route(() => json(res)),
      { pageSize: 1000 },
    );
    await expect(h.client.retrieve(OID)).rejects.toMatchObject({ kind: "incomplete" });
  });

  it("a response that sends headers and then stalls is aborted and treated as transient (no hang)", async () => {
    const h = harness(
      (url, init) => {
        if (!url.includes("/$expand")) return json(definition());
        return {
          ok: true,
          status: 200,
          headers: new Headers(),
          // Body never arrives; only the abort signal can end this promise.
          json: () =>
            new Promise((_, reject) =>
              init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
            ),
        } as unknown as Response;
      },
      { requestTimeoutMs: 25, maxRetries: 0 },
    );
    await expect(h.client.retrieve(OID)).rejects.toMatchObject({ kind: "transient" });
  });

  it("refuses an expansion above the size ceiling", async () => {
    const { client } = harness(
      route(() => {
        const res = expansion([{ system: SNOMED, code: "1", display: "a" }]);
        (res.expansion as { total: number }).total = 50_000;
        return json(res);
      }),
      { maxCodes: 10_000 },
    );
    await expect(client.retrieve(OID)).rejects.toMatchObject({ kind: "too_large" });
  });

  it("rejects a 200 with no expansion as malformed", async () => {
    const { client } = harness(route(() => json({ resourceType: "ValueSet" })));
    await expect(client.retrieve(OID)).rejects.toMatchObject({ kind: "malformed" });
  });

  it("content_sha256 changes when the code set changes and not when only the display does", async () => {
    const a = harness(
      route(() => json(expansion([{ system: SNOMED, code: "1", display: "one" }]))),
    );
    const b = harness(
      route(() => json(expansion([{ system: SNOMED, code: "1", display: "ONE (renamed)" }]))),
    );
    const c = harness(
      route(() => json(expansion([{ system: SNOMED, code: "2", display: "one" }]))),
    );
    const [ha, hb, hc] = await Promise.all([
      a.client.retrieve(OID).then((r) => r.provenance.content_sha256),
      b.client.retrieve(OID).then((r) => r.provenance.content_sha256),
      c.client.retrieve(OID).then((r) => r.provenance.content_sha256),
    ]);
    expect(ha).toBe(hb);
    expect(ha).not.toBe(hc);
  });
});

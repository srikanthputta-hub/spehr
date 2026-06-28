import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GRANT_SQL = `
GRANT SELECT, INSERT, UPDATE ON public.system_settings TO authenticated;
GRANT SELECT ON public.system_settings TO anon;
GRANT ALL ON public.system_settings TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.automation_watchdog_logs TO authenticated, anon;
GRANT ALL ON public.automation_watchdog_logs TO service_role;
GRANT SELECT, INSERT, UPDATE ON public.vitals TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE ON public.clinical_alerts TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE ON public.safety_alerts TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE ON public.staff_roster TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE ON public.patient_assignments TO authenticated, anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
`;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: number | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, rej) => {
        t = setTimeout(() => rej(new Error(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const result: { ok: boolean; method: string; note?: string } = {
    ok: true,
    method: "noop",
  };

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

    if (supabaseUrl && serviceKey) {
      const supabase = createClient(supabaseUrl, serviceKey, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      try {
        const rpc = await withTimeout(
          supabase.rpc("exec_sql", { sql: GRANT_SQL }) as unknown as Promise<{ error: unknown }>,
          4_000,
        );
        if ((rpc as { error: unknown }).error) {
          result.method = "rpc-missing";
          result.note = "exec_sql RPC unavailable; apply grants via migration";
        } else {
          result.method = "rpc";
        }
      } catch (e) {
        result.method = "rpc-timeout";
        result.note = (e as Error).message;
      }
    } else {
      result.method = "no-credentials";
    }
  } catch (error) {
    console.warn("[apply-grants] soft-fail", error);
    result.note = (error as Error).message;
  }

  // Always return 200 — recovery is best-effort; client uses localStorage fallback.
  return new Response(JSON.stringify(result), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
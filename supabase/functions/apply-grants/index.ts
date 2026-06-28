import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import postgres from "https://esm.sh/postgres@3.4.5";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const GRANT_SQL = `
CREATE OR REPLACE FUNCTION public.exec_sql(sql text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  EXECUTE sql;
END;
$$;
GRANT EXECUTE ON FUNCTION public.exec_sql(text) TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.system_settings TO authenticated;
GRANT SELECT ON public.system_settings TO anon;
GRANT ALL ON public.system_settings TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.automation_watchdog_logs TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.automation_watchdog_logs TO anon;
GRANT ALL ON public.automation_watchdog_logs TO service_role;

GRANT SELECT, INSERT, UPDATE ON public.vitals TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE ON public.clinical_alerts TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE ON public.safety_alerts TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE ON public.staff_roster TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE ON public.patient_assignments TO authenticated, anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
`;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: number | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const dbUrl =
      Deno.env.get("SUPABASE_DB_URL") ??
      Deno.env.get("DATABASE_URL") ??
      Deno.env.get("POSTGRES_URL") ??
      "";

    if (!supabaseUrl || !serviceKey) throw new Error("Backend service credentials are missing");

    if (dbUrl) {
      const sql = postgres(dbUrl, {
        max: 1,
        idle_timeout: 5,
        connect_timeout: 8,
        prepare: false,
      });
      try {
        await withTimeout(sql.unsafe(GRANT_SQL), 12_000);
      } finally {
        await sql.end({ timeout: 5 });
      }

      return new Response(JSON.stringify({ ok: true, method: "direct-postgres" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const rpc = await withTimeout(supabase.rpc("exec_sql", { sql: GRANT_SQL }), 8_000);
    if (rpc.error) throw rpc.error;

    return new Response(JSON.stringify({ ok: true, method: "rpc" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[apply-grants] failed", error);
    return new Response(JSON.stringify({ ok: false, error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

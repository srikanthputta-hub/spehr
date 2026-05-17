import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { HeartPulse, LogOut, Loader2 } from "lucide-react";

export const Route = createFileRoute("/dashboard")({
  component: Dashboard,
});

function Dashboard() {
  const navigate = useNavigate();
  const [email, setEmail] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (!data.session) {
        navigate({ to: "/" }).catch(() => {});
        return;
      }
      setEmail(data.session.user.email ?? null);
      setReady(true);
    });
  }, [navigate]);

  if (!ready) {
    return (
      <div className="min-h-screen grid place-items-center">
        <Loader2 className="h-5 w-5 animate-spin text-[var(--teal)]" />
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border bg-card">
        <div className="max-w-5xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="grid place-items-center h-9 w-9 rounded-lg bg-[var(--navy)] text-white">
              <HeartPulse className="h-5 w-5" />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                S Group
              </div>
              <div className="text-sm font-semibold leading-tight">
                Private Network
              </div>
            </div>
          </div>
          <button
            onClick={async () => {
              await supabase.auth.signOut();
              navigate({ to: "/" }).catch(() => {});
            }}
            className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
          >
            <LogOut className="h-4 w-4" /> Sign out
          </button>
        </div>
      </header>

      <section className="max-w-5xl mx-auto px-6 py-16">
        <h1 className="text-2xl font-semibold tracking-tight">
          Welcome back{email ? `, ${email}` : ""}.
        </h1>
        <p className="text-muted-foreground mt-2 max-w-xl">
          You're signed in. Your role-specific workspace will appear here —
          the Nurse Meditech Status Board is up next.
        </p>
      </section>
    </main>
  );
}

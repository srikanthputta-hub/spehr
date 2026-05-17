import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import {
  Activity,
  ShieldCheck,
  Stethoscope,
  HeartPulse,
  Lock,
  Mail,
  Loader2,
  Building2,
  UserCog,
} from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "S Group Private Network — Secure Staff Login" },
      {
        name: "description",
        content:
          "Secure access portal for S Group Private Network clinical staff. Sign in or register your role and branch.",
      },
    ],
  }),
  component: Index,
});

const ROLES = [
  { value: "registrar", label: "Registrar" },
  { value: "nurse", label: "Nurse" },
  { value: "physician", label: "Physician" },
  { value: "it_admin", label: "IT Admin" },
] as const;

const BRANCHES = [
  { value: "memorial_hospital", label: "Memorial Hospital" },
  { value: "ambulatory_center", label: "Ambulatory Center" },
  { value: "women_children", label: "Women & Children's" },
  { value: "regional_clinic", label: "Regional Clinic" },
  { value: "rehab", label: "Rehab" },
] as const;

function Index() {
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]["value"]>("nurse");
  const [branch, setBranch] = useState<(typeof BRANCHES)[number]["value"]>(
    "memorial_hospital",
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard" }).catch(() => {});
    });
  }, [navigate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);
    try {
      if (mode === "login") {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
        navigate({ to: "/dashboard" }).catch(() => {});
      } else {
        const { error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            emailRedirectTo: `${window.location.origin}/`,
            data: { role, branch },
          },
        });
        if (error) throw error;
        setInfo(
          "Account created. Please check your email to verify, then sign in.",
        );
        setMode("login");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="min-h-screen grid lg:grid-cols-2 bg-background">
      {/* Brand panel */}
      <aside className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-[var(--navy)] text-white p-12">
        <div
          className="absolute inset-0 opacity-60"
          style={{
            background:
              "radial-gradient(120% 80% at 0% 0%, oklch(0.32 0.08 200 / 0.55), transparent 60%), radial-gradient(80% 60% at 100% 100%, oklch(0.62 0.11 190 / 0.35), transparent 60%)",
          }}
        />
        <div
          className="absolute inset-0 opacity-[0.07]"
          style={{
            backgroundImage:
              "linear-gradient(to right, white 1px, transparent 1px), linear-gradient(to bottom, white 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }}
        />

        <div className="relative flex items-center gap-3">
          <div className="grid place-items-center h-11 w-11 rounded-xl bg-[var(--teal)] text-white shadow-lg shadow-black/20">
            <HeartPulse className="h-6 w-6" strokeWidth={2.4} />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-white/60">
              S Group
            </div>
            <div className="text-lg font-semibold leading-tight">
              Private Network
            </div>
          </div>
        </div>

        <div className="relative space-y-8 max-w-md">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/5 backdrop-blur px-3 py-1 text-xs text-white/80">
            <ShieldCheck className="h-3.5 w-3.5 text-[var(--teal)]" />
            HIPAA-grade secure access
          </div>
          <h1 className="text-4xl xl:text-5xl font-semibold leading-[1.05] tracking-tight">
            The clinical command layer for every shift.
          </h1>
          <p className="text-white/70 leading-relaxed">
            Unified patient status, live vitals, and role-aware workflows
            across every S Group facility — from Memorial Hospital to the
            Regional Clinic.
          </p>

          <div className="grid grid-cols-3 gap-3 pt-2">
            {[
              { icon: Activity, label: "Live vitals" },
              { icon: Stethoscope, label: "Role views" },
              { icon: Building2, label: "5 branches" },
            ].map(({ icon: Icon, label }) => (
              <div
                key={label}
                className="rounded-xl border border-white/10 bg-white/[0.04] backdrop-blur px-3 py-3"
              >
                <Icon className="h-4 w-4 text-[var(--teal)]" />
                <div className="mt-2 text-xs text-white/75">{label}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="relative text-xs text-white/50">
          © {new Date().getFullYear()} S Group Health Network · Authorized
          personnel only
        </div>
      </aside>

      {/* Auth panel */}
      <section className="flex items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-md">
          <div className="lg:hidden mb-8 flex items-center gap-3">
            <div className="grid place-items-center h-10 w-10 rounded-xl bg-[var(--navy)] text-white">
              <HeartPulse className="h-5 w-5" />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
                S Group
              </div>
              <div className="text-base font-semibold">Private Network</div>
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card shadow-[0_1px_0_rgba(15,23,42,0.04),0_24px_60px_-30px_rgba(15,23,42,0.25)] p-7 sm:p-8">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold tracking-tight text-foreground">
                  {mode === "login" ? "Sign in" : "Create account"}
                </h2>
                <p className="text-sm text-muted-foreground mt-1">
                  {mode === "login"
                    ? "Access your clinical workspace."
                    : "Register your role and branch to continue."}
                </p>
              </div>
              <Lock className="h-5 w-5 text-[var(--teal)]" />
            </div>

            {/* Segmented toggle */}
            <div className="mt-6 grid grid-cols-2 rounded-lg bg-secondary p-1 text-sm">
              {(["login", "register"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMode(m);
                    setError(null);
                    setInfo(null);
                  }}
                  className={`rounded-md px-3 py-1.5 font-medium transition ${
                    mode === m
                      ? "bg-card text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {m === "login" ? "Login" : "Register"}
                </button>
              ))}
            </div>

            <form onSubmit={handleSubmit} className="mt-6 space-y-4">
              <Field label="Work email" htmlFor="email" icon={Mail}>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@sgroup.health"
                  className="w-full bg-transparent outline-none text-sm placeholder:text-muted-foreground"
                />
              </Field>

              <Field label="Password" htmlFor="password" icon={Lock}>
                <input
                  id="password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete={
                    mode === "login" ? "current-password" : "new-password"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-transparent outline-none text-sm placeholder:text-muted-foreground"
                />
              </Field>

              {mode === "register" && (
                <>
                  <SelectField
                    label="Select your role"
                    htmlFor="role"
                    icon={UserCog}
                    value={role}
                    onChange={(v) => setRole(v as typeof role)}
                    options={ROLES}
                  />
                  <SelectField
                    label="Select your branch"
                    htmlFor="branch"
                    icon={Building2}
                    value={branch}
                    onChange={(v) => setBranch(v as typeof branch)}
                    options={BRANCHES}
                  />
                </>
              )}

              {error && (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {error}
                </div>
              )}
              {info && (
                <div className="rounded-md border border-[var(--teal)]/30 bg-[var(--teal-soft)] px-3 py-2 text-sm text-foreground">
                  {info}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full inline-flex items-center justify-center gap-2 rounded-lg bg-[var(--navy)] text-white text-sm font-medium h-11 transition hover:bg-[var(--navy)]/92 disabled:opacity-60"
              >
                {loading && <Loader2 className="h-4 w-4 animate-spin" />}
                {mode === "login" ? "Sign in securely" : "Create account"}
              </button>

              <p className="text-[11px] text-muted-foreground text-center pt-1">
                By continuing you agree to S Group's acceptable use policy.
                Sessions are monitored.
              </p>
            </form>
          </div>
        </div>
      </section>
    </main>
  );
}

function Field({
  label,
  htmlFor,
  icon: Icon,
  children,
}: {
  label: string;
  htmlFor: string;
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="text-xs font-medium text-foreground/80"
      >
        {label}
      </label>
      <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-input bg-background h-11 px-3 focus-within:ring-2 focus-within:ring-[var(--teal)]/40 focus-within:border-[var(--teal)] transition">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {children}
      </div>
    </div>
  );
}

function SelectField({
  label,
  htmlFor,
  icon: Icon,
  value,
  onChange,
  options,
}: {
  label: string;
  htmlFor: string;
  icon: React.ComponentType<{ className?: string }>;
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<{ value: string; label: string }>;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="text-xs font-medium text-foreground/80"
      >
        {label}
      </label>
      <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-input bg-background h-11 px-3 focus-within:ring-2 focus-within:ring-[var(--teal)]/40 focus-within:border-[var(--teal)] transition">
        <Icon className="h-4 w-4 text-muted-foreground" />
        <select
          id={htmlFor}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full bg-transparent outline-none text-sm appearance-none cursor-pointer"
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

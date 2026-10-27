import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, MessageSquare, Send, Inbox } from "lucide-react";
import { toast } from "sonner";

interface CommRow {
  id: string;
  mrn: string;
  facility_name: string | null;
  sender: string;
  sender_label: string | null;
  recipient: string;
  subject: string | null;
  message: string;
  status: string;
  parent_id: string | null;
  created_at: string;
}

export function PatientCommsInbox({
  mrn,
  facility,
  providerLabel,
}: {
  mrn: string;
  facility?: string;
  providerLabel: string;
}) {
  const [rows, setRows] = useState<CommRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [reply, setReply] = useState("");
  const [sending, setSending] = useState(false);

  const load = async () => {
    const { data } = await supabase
      .from("fhir_communications")
      .select("*")
      .eq("mrn", mrn)
      .order("created_at", { ascending: true })
      .limit(100);
    setRows((data ?? []) as CommRow[]);
    setLoading(false);
    // Auto-mark patient messages as read
    const unread = ((data ?? []) as CommRow[]).filter(
      (m) => m.sender === "patient" && m.status === "unread",
    );
    if (unread.length) {
      await supabase
        .from("fhir_communications")
        .update({ status: "read" })
        .in(
          "id",
          unread.map((u) => u.id),
        );
    }
  };

  useEffect(() => {
    load();
    const ch = supabase
      .channel(`comms-${mrn}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "fhir_communications", filter: `mrn=eq.${mrn}` },
        () => load(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mrn]);

  const unreadCount = useMemo(
    () => rows.filter((r) => r.sender === "patient" && r.status === "unread").length,
    [rows],
  );

  const send = async () => {
    const text = reply.trim();
    if (!text) return;
    setSending(true);
    const resource = {
      resourceType: "Communication",
      status: "completed",
      subject: { reference: `Patient/${mrn}` },
      sent: new Date().toISOString(),
      sender: { display: providerLabel },
      recipient: [{ reference: `Patient/${mrn}` }],
      payload: [{ contentString: text }],
    };
    const { error } = await supabase.from("fhir_communications").insert({
      mrn,
      facility_name: facility ?? null,
      sender: "provider",
      sender_label: providerLabel,
      recipient: "patient",
      subject: null,
      message: text,
      status: "completed",
      resource,
    });
    setSending(false);
    if (error) {
      toast.error("Failed to send reply", { description: error.message });
      return;
    }
    setReply("");
    toast.success("Reply sent to patient");
  };

  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 h-11 border-b border-border bg-secondary/40">
        <div className="flex items-center gap-2">
          <Inbox className="h-4 w-4 text-[var(--teal)]" />
          <h3 className="text-sm font-semibold">Patient Communications</h3>
          {unreadCount > 0 && (
            <span className="inline-flex items-center justify-center rounded-full bg-rose-500 text-white text-[10px] font-bold h-4 min-w-4 px-1.5">
              {unreadCount}
            </span>
          )}
        </div>
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--teal)]">
          FHIR Communication · Live
        </span>
      </div>
      {loading ? (
        <div className="grid place-items-center h-24 text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : rows.length === 0 ? (
        <div className="px-5 py-6 text-center text-xs text-muted-foreground">
          No messages yet. Send a note below — the patient will see it in MySPEHR.
        </div>
      ) : (
        <ul className="divide-y divide-border max-h-80 overflow-y-auto">
          {rows.map((m) => {
            const fromPatient = m.sender === "patient";
            return (
              <li key={m.id} className={`px-5 py-2.5 ${fromPatient ? "bg-amber-50/40" : ""}`}>
                <div className="flex items-center justify-between mb-1">
                  <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
                    <MessageSquare className="h-3 w-3" />
                    {fromPatient ? `Patient ${mrn}` : m.sender_label || "Provider"}
                  </div>
                  <div className="text-[10px] font-mono text-slate-400">
                    {new Date(m.created_at).toLocaleString()}
                  </div>
                </div>
                {m.subject && (
                  <div className="text-xs font-semibold text-slate-900">{m.subject}</div>
                )}
                <div className="text-[13px] text-slate-800 whitespace-pre-wrap">{m.message}</div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="border-t border-border p-3 flex items-start gap-2 bg-secondary/20">
        <textarea
          value={reply}
          onChange={(e) => setReply(e.target.value)}
          rows={2}
          placeholder="Reply to patient…"
          className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
        />
        <button
          type="button"
          onClick={send}
          disabled={sending || !reply.trim()}
          className="inline-flex items-center gap-1.5 rounded-md bg-[var(--teal)] hover:bg-[var(--teal)]/90 text-white px-3 h-9 text-xs font-semibold shadow-sm disabled:opacity-60"
        >
          {sending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
          Send
        </button>
      </div>
    </section>
  );
}


function SbarPill({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-md bg-background border border-border px-2 py-1.5">
      <div className="text-[10px] font-bold text-[var(--teal)] uppercase tracking-wider">
        {label}
      </div>
      <div className="text-xs text-foreground/90 mt-0.5">{text}</div>
    </div>
  );
}

function SbarInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={`${label}…`}
        className="mt-1 w-full rounded-md border border-border bg-background px-2.5 h-9 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--teal)]/40"
      />
    </label>
  );
}

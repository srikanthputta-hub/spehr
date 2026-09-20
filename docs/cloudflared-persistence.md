# Making the RuFlo Office tunnel survive reboot/logoff

Three processes currently run as plain foreground/background jobs and die on
reboot or logoff: `cloudflared tunnel run ruflo-office`, `node
dashboard/server.mjs`, and `ruflo daemon start`.

## 1. Install cloudflared as a Windows service

The binary is portable (`C:\Users\srika\AppData\Local\cloudflared\cloudflared.exe`),
not on PATH. Service install needs local admin rights, so **the human must run
this**, not Claude Code, from an elevated (Run as Administrator) terminal:

```powershell
& "C:\Users\srika\AppData\Local\cloudflared\cloudflared.exe" service install
```

This reads `C:\Users\srika\.cloudflared\config.yml` (tunnel `ruflo-office`,
id `f6e2de18-f986-49cc-ad3c-df1ce9130f1c`, ingress `office.spehr.live ->
http://localhost:4173`) and registers a `cloudflared` Windows service set to
auto-start. Manage it afterward with `sc query cloudflared` / `services.msc`.

## 2. Auto-start the dashboard + ruflo daemon

These are plain Node/CLI processes, not part of cloudflared, so they need
their own Task Scheduler entries. GUI (`taskschd.msc`) works, but these
`schtasks` commands are simpler to hand the human directly (also needs a
normal, non-admin terminal is fine here):

```powershell
schtasks /create /tn "RuFlo Daemon" /tr "ruflo daemon start" /sc onlogon /rl limited /f

schtasks /create /tn "RuFlo Dashboard" /tr "node C:\Users\srika\spehr\dashboard\server.mjs" /sc onlogon /rl limited /f
```

Notes:
- `/sc onlogon` = "At log on" trigger, matching the ask.
- If `ruflo` isn't on PATH under the Task Scheduler's environment, use the
  fully-qualified path to its executable/shim instead of the bare command.
- Order matters loosely: the dashboard should be up before the tunnel forwards
  traffic to it, but Task Scheduler starting both at logon is fine in
  practice — the tunnel will just 502 for a few seconds until the dashboard
  binds port 4173.

## 3. Verify it survived a reboot

1. Reboot (or log off/on) the machine.
2. `sc query cloudflared` → `STATE: RUNNING`.
3. `schtasks /query /tn "RuFlo Daemon"` and `/tn "RuFlo Dashboard"` →
   `Status: Running` (or `Ready` immediately after, `Running` once triggered).
4. `curl http://localhost:4173` locally → dashboard HTML responds.
5. From another device (not on the same LAN), open `https://office.spehr.live`
   → Office dashboard loads without needing to re-run anything by hand.
6. Check Task Scheduler's history/last-run-result for both tasks is `0x0`
   (success) if step 4/5 fail — most common culprit is a PATH issue for
   `ruflo` under the scheduled-task environment.

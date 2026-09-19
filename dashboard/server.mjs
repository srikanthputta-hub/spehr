import http from 'node:http';
import { exec, execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const pexec = promisify(exec);
const pexecFile = promisify(execFile);

const PROJECT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = process.env.RUFLO_DASHBOARD_PORT ? Number(process.env.RUFLO_DASHBOARD_PORT) : 4173;

async function run(cmd) {
  try {
    const { stdout } = await pexec(cmd, { cwd: PROJECT_DIR, timeout: 15000, maxBuffer: 10 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    return err.stdout || '';
  }
}

const AGENT_ID_RE = /^agent-[A-Za-z0-9_-]+$/;
const AGENTS_STORE_PATH = () => path.join(PROJECT_DIR, '.claude-flow', 'agents', 'store.json');
const TASKS_STORE_PATH = () => path.join(PROJECT_DIR, '.claude-flow', 'tasks', 'store.json');

// The `ruflo agent list --format json` CLI strips custom fields (model,
// modelRoutedBy) that the office-task-bridge writes when it registers a
// subagent spawn. Read the store directly to recover them for display —
// same ground-truth-over-CLI approach as loadTaskStore() below.
async function loadAgentModelMeta() {
  try {
    const raw = await readFile(AGENTS_STORE_PATH(), 'utf8');
    const parsed = JSON.parse(raw);
    const meta = {};
    for (const [id, a] of Object.entries(parsed.agents || {})) {
      meta[id] = { model: a.model || null, modelRoutedBy: a.modelRoutedBy || null };
    }
    return meta;
  } catch {
    return {};
  }
}

// "Not working anymore" = removed, not left as an idle ghost — delete the
// agent (and any task assigned to it) from the stores entirely so its desk
// disappears from the board, whether it was stopped from the dashboard or
// finished via the office-task-bridge.
async function removeAgentEntirely(agentId) {
  try {
    const [agentsRaw, tasksRaw] = await Promise.all([
      readFile(AGENTS_STORE_PATH(), 'utf8').catch(() => null),
      readFile(TASKS_STORE_PATH(), 'utf8').catch(() => null),
    ]);
    if (agentsRaw) {
      const agentsStore = JSON.parse(agentsRaw);
      delete agentsStore.agents?.[agentId];
      await writeFile(AGENTS_STORE_PATH(), JSON.stringify(agentsStore, null, 2));
    }
    if (tasksRaw) {
      const tasksStore = JSON.parse(tasksRaw);
      for (const [taskId, t] of Object.entries(tasksStore.tasks || {})) {
        if ((t.assignedTo || []).includes(agentId)) delete tasksStore.tasks[taskId];
      }
      await writeFile(TASKS_STORE_PATH(), JSON.stringify(tasksStore, null, 2));
    }
  } catch { /* best-effort cleanup — stop already succeeded either way */ }
}

async function stopAgent(agentId) {
  if (!AGENT_ID_RE.test(agentId)) return { ok: false, error: 'invalid agent id' };
  try {
    await pexecFile('ruflo', ['--no-color', 'agent', 'stop', agentId], {
      cwd: PROJECT_DIR, timeout: 35000, maxBuffer: 5 * 1024 * 1024, shell: true
    });
    await removeAgentEntirely(agentId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message || 'stop failed' };
  }
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      try { return JSON.parse(raw.slice(start, end + 1)); } catch { /* fall through */ }
    }
    return null;
  }
}

function parseDaemonStatus(text) {
  const running = /RUNNING/i.test(text);
  const pidMatch = text.match(/PID:\s*(\d+)/);
  const workers = [];
  const lineRe = /\|\s*([\w-]+)\s*\|\s*(✓|○)\s*\|\s*(\w+)\s*\|\s*(\d+)\s*\|\s*([\d.]+%)\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|/g;
  let m;
  while ((m = lineRe.exec(text))) {
    if (m[1] === 'Worker') continue;
    workers.push({
      name: m[1], enabled: m[2] === '✓', status: m[3], runs: Number(m[4]),
      success: m[5], lastRun: m[6].trim(), nextRun: m[7].trim()
    });
  }
  return { running, pid: pidMatch ? Number(pidMatch[1]) : null, workers };
}

function buildTasksByAgent(tasks) {
  const map = {};
  for (const t of tasks || []) {
    for (const agentId of t.assignedTo || []) {
      (map[agentId] ||= []).push({
        taskId: t.taskId ?? t.id,
        type: t.type,
        description: t.description,
        status: t.status,
        progress: t.progress,
        priority: t.priority,
        createdAt: t.createdAt,
        pipeline: t.pipeline || null,
      });
    }
  }
  return map;
}

async function loadTaskStore() {
  // `ruflo task list` has a confirmed bug in v3.42.3: its status filter does a
  // literal equality check against the CLI's own enum (pending/running/completed/
  // failed/cancelled/all), but tasks are actually stored with status "in_progress"
  // — never "running" — and the "all" filter value is never special-cased, so
  // both the default filter and --all silently return an empty array even when
  // in-progress tasks exist (verified against a real assigned task). `task status
  // <id>` returns correct data, but there's no way to enumerate task IDs first
  // without hitting the same broken list. Reading the store file directly sidesteps
  // the bug entirely and matches the same ground-truth-over-CLI approach already
  // used for the agent store's undocumented `currentTask` field.
  try {
    const raw = await readFile(path.join(PROJECT_DIR, '.claude-flow', 'tasks', 'store.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const tasks = Object.values(parsed.tasks || {});
    return { tasks, total: tasks.length };
  } catch {
    return { tasks: [], total: 0 };
  }
}

// Last known-good agent list, used to guard against a single poll cycle
// racing a non-atomic writer of .claude-flow/agents/store.json (e.g. an
// external tool mid-write) and seeing the `ruflo agent list` subprocess
// return unparseable or suspiciously-empty output for that one tick. Without
// this, safeJsonParse's fallback to {agents:[],total:0} would look like every
// agent vanished, then reappeared next cycle — a spurious spawn/stop flicker
// in the client's diffAndTick ticker.
let lastGoodAgents = null;

async function collect() {
  const [agentsRaw, swarmRaw, memRaw, taskList, daemonRaw, modelMeta] = await Promise.all([
    run('ruflo --no-color --format json agent list'),
    run('ruflo --no-color --format json swarm status'),
    run('ruflo --no-color --format json status memory'),
    loadTaskStore(),
    run('ruflo daemon status'),
    loadAgentModelMeta(),
  ]);

  const parsedRaw = safeJsonParse(agentsRaw);
  const rawList = parsedRaw && Array.isArray(parsedRaw.agents) ? parsedRaw.agents : null;
  const lastCount = lastGoodAgents ? lastGoodAgents.length : 0;

  // Treat this cycle's read as untrustworthy if parsing failed outright, or
  // if it suddenly reports zero agents right after a cycle that had several
  // — a lone agent legitimately finishing wouldn't zero the whole list, so a
  // drop straight to 0 from >1 is far more likely a torn read than reality.
  const suspiciouslyEmpty = rawList === null || (rawList.length === 0 && lastCount > 1);

  const agentsParsed = suspiciouslyEmpty
    ? { agents: lastGoodAgents || [], total: (lastGoodAgents || []).length, stale: true }
    : { ...parsedRaw, agents: rawList };

  if (!suspiciouslyEmpty) lastGoodAgents = rawList;

  for (const a of agentsParsed.agents || []) {
    const meta = modelMeta[a.agentId];
    a.model = meta?.model || null;
    a.modelRoutedBy = meta?.modelRoutedBy || null;
  }

  return {
    agents: agentsParsed,
    swarm: safeJsonParse(swarmRaw) || null,
    memory: safeJsonParse(memRaw) || null,
    tasks: taskList,
    tasksByAgent: buildTasksByAgent(taskList.tasks),
    daemon: parseDaemonStatus(daemonRaw),
    timestamp: new Date().toISOString(),
  };
}

const HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>RuFlo Office</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background:
      radial-gradient(ellipse 90% 70% at 50% 38%, #1a2540 0%, #0a0c14 62%, #060709 100%);
    color: #e7eaf3;
    font: 13px/1.4 -apple-system, Segoe UI, Roboto, sans-serif;
    overflow: hidden;
  }
  .office { position: relative; width: 100vw; height: 100vh; }

  header {
    position: absolute; top: 0; left: 0; right: 0; z-index: 20;
    display: flex; align-items: center; justify-content: space-between;
    padding: 16px 22px; pointer-events: none;
  }
  .brand { font-weight: 800; letter-spacing: .12em; font-size: 13px; color: #cfd6ea; pointer-events: auto; }
  .brand span { color: #6d7690; font-weight: 600; }
  .brand .live { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #35e08a; margin-right: 8px; box-shadow: 0 0 8px #35e08a; animation: pulse 1.6s infinite; vertical-align: 1px; }
  .conn-row { display: flex; gap: 6px; align-items: center; pointer-events: auto; }
  .conn-chip { display: flex; align-items: center; gap: 6px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08); padding: 5px 10px; border-radius: 999px; font-size: 11px; color: #9aa2ba; backdrop-filter: blur(6px); }
  .conn-chip .dot { width: 6px; height: 6px; border-radius: 50%; background: #4a5170; }
  .conn-chip.on .dot { background: #35e08a; box-shadow: 0 0 6px #35e08a; }
  .conn-chip.off .dot { background: #e0435c; }

  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }

  .stage { position: absolute; inset: 0; }
  .floor {
    position: absolute; inset: 0;
    background-image:
      linear-gradient(rgba(255,255,255,.025) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px);
    background-size: 46px 46px;
    mask-image: radial-gradient(ellipse 75% 65% at 50% 48%, black 40%, transparent 78%);
  }
  .wires { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .wires path.wire { fill: none; stroke: rgba(140,160,255,.28); stroke-width: .18; stroke-dasharray: .6 1.1; animation: flow 12s linear infinite; vector-effect: non-scaling-stroke; }
  .wires path.wire.hot { stroke: rgba(160,220,255,.55); }
  .wires circle.pulse { fill: #9db2ff; filter: drop-shadow(0 0 3px #9db2ff); }
  @keyframes flow { to { stroke-dashoffset: -60; } }

  .hub {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%,-50%);
    width: 84px; height: 84px; z-index: 5; cursor: pointer;
  }
  .hub-ring { position: absolute; inset: -10px; border-radius: 50%; border: 1px solid rgba(140,160,255,.35); opacity: 0; }
  .hub-ring.pulsing { animation: ringpulse 1.1s ease-out; }
  @keyframes ringpulse { 0% { opacity: .9; transform: scale(.85); } 100% { opacity: 0; transform: scale(1.7); } }
  .hub-core {
    position: absolute; inset: 0; border-radius: 50%;
    background: radial-gradient(circle at 40% 35%, #9db2ff, #4b5bd6 55%, #222a5c 100%);
    box-shadow: 0 0 40px 6px rgba(90,110,255,.45), 0 0 0 1px rgba(255,255,255,.15) inset;
    animation: breathe 3.4s ease-in-out infinite;
    transition: box-shadow .3s ease;
  }
  .hub.active .hub-core { box-shadow: 0 0 54px 10px rgba(120,150,255,.65), 0 0 0 1px rgba(255,255,255,.2) inset; }
  @keyframes breathe { 0%,100% { transform: scale(1); } 50% { transform: scale(1.06); } }
  .hub-label { position: absolute; top: 100%; left: 50%; transform: translateX(-50%); margin-top: 8px; font-size: 10px; font-weight: 800; letter-spacing: .1em; color: #9aa2ba; white-space: nowrap; text-align: center; }
  .hub-sub { font-size: 9px; color: #565e78; font-weight: 600; display: block; margin-top: 1px; }

  /* ---- Office pods (department rooms) ---- */
  .platform-wrap { position: absolute; z-index: 4; transform: translate(-50%,-50%); }
  .pod-bob { animation: bob 4.4s ease-in-out infinite; animation-delay: var(--bob-delay, 0s); }
  @keyframes bob { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
  .pod {
    position: relative; cursor: pointer;
    background: linear-gradient(180deg, rgba(255,255,255,.05), rgba(255,255,255,.015)), #12151f;
    border: 1px solid var(--accent-dim, rgba(255,255,255,.12));
    border-radius: 14px; padding: 10px 12px 9px; min-width: 100px; max-width: 210px;
    box-shadow: 0 18px 34px -16px rgba(0,0,0,.7), 0 0 0 1px rgba(0,0,0,.3) inset;
    transition: filter .2s ease, transform .2s ease, box-shadow .3s ease;
  }
  .pod::before {
    content: ''; position: absolute; top: 0; left: 12px; right: 12px; height: 3px;
    background: var(--accent, #7aa6ff); border-radius: 0 0 3px 3px; opacity: .9;
  }
  .pod::after {
    content: ''; position: absolute; inset: -5px; border-radius: 18px; border: 1.5px solid var(--accent, #7aa6ff);
    opacity: 0; pointer-events: none;
  }
  .platform-wrap.has-active .pod::after { opacity: .55; animation: activering 1.6s ease-in-out infinite; }
  @keyframes activering { 0%,100% { opacity: .25; } 50% { opacity: .85; } }
  .platform-wrap.selected .pod { filter: brightness(1.22); }
  .platform-wrap:hover .pod { filter: brightness(1.15); transform: translateY(-1px); }

  .pod-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 9px; padding-top: 2px; }
  .pod-team { font-size: 10px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--accent, #7aa6ff); white-space: nowrap; }
  .pod-count { font-size: 10.5px; font-weight: 700; color: #9aa2ba; transition: transform .25s ease; display: inline-block; }
  .pod-count.bump { animation: bump .4s ease; }
  @keyframes bump { 0% { transform: scale(1); } 40% { transform: scale(1.4); color: #fff; } 100% { transform: scale(1); } }

  .desks { display: flex; flex-wrap: wrap; gap: 12px 10px; justify-content: center; max-width: 186px; }
  .desk { position: relative; width: 34px; display: flex; flex-direction: column; align-items: center; }
  .desk .worker { font-size: 21px; line-height: 1; filter: drop-shadow(0 2px 3px rgba(0,0,0,.55)); transition: transform .18s ease; }
  .desk:hover .worker { transform: scale(1.18) translateY(-1px); }
  .desk .mat { width: 28px; height: 5px; border-radius: 3px; margin-top: 3px; background: var(--accent, #7aa6ff); opacity: .8; box-shadow: 0 3px 6px -1px rgba(0,0,0,.5); }
  .desk .light { position: absolute; top: -3px; right: 1px; width: 7px; height: 7px; border-radius: 50%; border: 1px solid rgba(0,0,0,.4); }
  .desk .light.green { background: #35e08a; box-shadow: 0 0 7px 1px #35e08a; animation: lightpulse 1.5s ease-in-out infinite; }
  .desk .light.red { background: #e0435c; box-shadow: 0 0 5px #e0435c88; }
  @keyframes lightpulse { 0%,100% { opacity: 1; } 50% { opacity: .5; } }
  .desk .model-badge {
    position: absolute; top: -3px; left: 1px; width: 12px; height: 12px; border-radius: 4px;
    font-size: 8px; font-weight: 800; line-height: 12px; text-align: center; color: #0a0c14;
    border: 1px solid rgba(0,0,0,.35); box-shadow: 0 1px 3px rgba(0,0,0,.5);
  }
  .pod-model-legend { font-size: 8.5px; color: #6d7690; margin-top: 6px; text-align: center; letter-spacing: .01em; }
  .model-chip { display: inline-flex; align-items: center; gap: 4px; font-size: 10px; font-weight: 700; padding: 1px 6px 1px 4px; border-radius: 999px; }
  .model-chip .sw { width: 8px; height: 8px; border-radius: 3px; display: inline-block; }
  .legend-bar {
    position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 20;
    display: flex; gap: 10px; align-items: center; background: rgba(16,19,30,.85); border: 1px solid rgba(255,255,255,.08);
    border-radius: 999px; padding: 6px 14px; font-size: 10.5px; color: #9aa2ba; backdrop-filter: blur(8px);
    pointer-events: none; white-space: nowrap;
  }

  /* speech bubble tooltip */
  .desk-tip {
    position: fixed; z-index: 60; max-width: 230px; pointer-events: none;
    background: #f4f6fb; color: #191b22; font-size: 11.5px; line-height: 1.35;
    padding: 8px 11px; border-radius: 12px; border-bottom-left-radius: 3px;
    box-shadow: 0 12px 28px -10px rgba(0,0,0,.6);
    opacity: 0; transform: translateY(4px) scale(.97); transition: opacity .12s ease, transform .12s ease;
  }
  .desk-tip.show { opacity: 1; transform: translateY(0) scale(1); }
  .desk-tip b { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #6b7080; margin-bottom: 3px; font-weight: 800; }

  .empty-hint {
    position: absolute; top: 50%; left: 50%; transform: translate(-50%, 60px);
    color: #6d7690; font-size: 12px; text-align: center; width: 260px;
  }

  .search-box {
    pointer-events: auto; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1);
    border-radius: 999px; padding: 5px 12px; font: inherit; font-size: 11.5px; color: #e7eaf3;
    width: 140px; transition: width .2s ease, background .2s ease;
  }
  .search-box::placeholder { color: #6d7690; }
  .search-box:focus { outline: none; width: 190px; background: rgba(255,255,255,.08); border-color: rgba(140,160,255,.4); }

  .work-panel {
    position: fixed; left: 16px; top: 64px; z-index: 22; width: 250px; max-height: calc(100vh - 100px);
    display: flex; flex-direction: column; background: rgba(11,13,20,.9); border: 1px solid rgba(255,255,255,.08);
    border-radius: 12px; backdrop-filter: blur(10px); box-shadow: 0 14px 30px -12px rgba(0,0,0,.6);
    transition: transform .22s ease;
  }
  .work-panel.collapsed { transform: translateX(calc(-100% + 34px)); }
  .work-panel-head {
    display: flex; align-items: center; justify-content: space-between; padding: 9px 12px;
    border-bottom: 1px solid rgba(255,255,255,.07); cursor: pointer; flex-shrink: 0;
  }
  .work-panel-head .t { font-size: 10px; font-weight: 800; letter-spacing: .08em; color: #9aa2ba; }
  .work-panel-head .n { font-size: 10px; font-weight: 800; color: #35e08a; background: rgba(53,224,138,.12); padding: 1px 7px; border-radius: 999px; }
  .work-panel-body { overflow-y: auto; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
  .work-row {
    display: flex; flex-direction: column; gap: 2px; background: rgba(255,255,255,.035);
    border: 1px solid rgba(255,255,255,.06); border-left: 3px solid var(--accent, #7aa6ff);
    border-radius: 7px; padding: 6px 9px; cursor: pointer; transition: background .15s ease;
  }
  .work-row:hover { background: rgba(255,255,255,.07); }
  .work-row .role { font-size: 9.5px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: var(--accent, #7aa6ff); }
  .work-row .desc { font-size: 11px; color: #cfd6ea; line-height: 1.3; margin-top: 1px; }
  .work-row .meta { font-size: 9.5px; color: #565e78; margin-top: 2px; }
  .work-empty { color: #565e78; font-size: 11px; text-align: center; padding: 14px 8px; }

  .pipeline-tag {
    display: inline-flex; align-items: center; gap: 3px; font-size: 9px; font-weight: 700;
    color: #ffdd7a; background: rgba(255,221,122,.12); border: 1px solid rgba(255,221,122,.25);
    border-radius: 999px; padding: 1px 7px; margin-top: 3px;
  }

  .toast { position: fixed; bottom: 22px; left: 22px; background: rgba(16,19,30,.95); border: 1px solid rgba(255,255,255,.1); padding: 9px 15px; border-radius: 10px; font-size: 12.5px; opacity: 0; transform: translateY(8px); transition: all .25s ease; pointer-events: none; z-index: 40; }
  .toast.show { opacity: 1; transform: translateY(0); }

  .ticker {
    position: fixed; left: 50%; bottom: 18px; transform: translateX(-50%);
    display: flex; flex-direction: column-reverse; gap: 6px; z-index: 25; pointer-events: none;
    align-items: center; width: min(560px, 90vw);
  }
  .ticker-item {
    background: rgba(14,17,28,.92); border: 1px solid rgba(255,255,255,.1); border-radius: 999px;
    padding: 6px 14px; font-size: 11.5px; color: #cfd6ea; backdrop-filter: blur(8px);
    animation: tickerIn .35s ease, tickerOut .4s ease 3.4s forwards;
    box-shadow: 0 8px 20px -8px rgba(0,0,0,.6); white-space: nowrap;
  }
  @keyframes tickerIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes tickerOut { to { opacity: 0; transform: translateY(-6px); } }

  .drawer {
    position: fixed; top: 0; right: 0; bottom: 0; width: 340px; max-width: 90vw; z-index: 50;
    background: rgba(11,13,20,.97); border-left: 1px solid rgba(255,255,255,.08);
    backdrop-filter: blur(14px); display: flex; flex-direction: column;
    transform: translateX(100%); transition: transform .28s ease;
  }
  .drawer.open { transform: translateX(0); }
  .drawer-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid rgba(255,255,255,.08); }
  .drawer-head .title { font-weight: 800; font-size: 13px; letter-spacing: .05em; }
  .drawer-head .sub { font-size: 10.5px; color: #6d7690; margin-top: 2px; }
  .drawer-close { background: none; border: none; color: #6d7690; font-size: 18px; cursor: pointer; padding: 2px 6px; }
  .drawer-body { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
  .drawer-empty { color: #565e78; font-size: 12px; text-align: center; margin-top: 30px; }
  .drawer-stat-row { display: flex; gap: 8px; }
  .drawer-stat { flex: 1; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 9px; padding: 8px 10px; }
  .drawer-stat .n { font-size: 17px; font-weight: 800; }
  .drawer-stat .l { font-size: 9.5px; color: #6d7690; text-transform: uppercase; letter-spacing: .05em; margin-top: 2px; }
  .agent-row { display: flex; align-items: center; gap: 9px; background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); border-radius: 9px; padding: 8px 10px; }
  .agent-row .status-dot { width: 7px; height: 7px; border-radius: 50%; background: #e0435c; flex-shrink: 0; }
  .agent-row.active .status-dot { background: #35e08a; box-shadow: 0 0 6px #35e08a; }
  .agent-row .info { flex: 1; min-width: 0; }
  .agent-row .id { font-size: 10.5px; font-family: ui-monospace, monospace; color: #9aa2ba; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .agent-row .stats { font-size: 10px; color: #565e78; margin-top: 1px; }
  .agent-row .stats.task { color: #9db2ff; margin-top: 2px; }
  .agent-row button { font: inherit; font-size: 10.5px; font-weight: 700; color: #ff9fae; background: rgba(224,67,92,.12); border: 1px solid rgba(224,67,92,.3); border-radius: 6px; padding: 4px 8px; cursor: pointer; flex-shrink: 0; }
  .agent-row button:hover { background: rgba(224,67,92,.22); }
  .agent-row button:disabled { opacity: .4; cursor: default; }
</style>
</head>
<body>
<div class="office">
  <header>
    <div class="brand"><span class="live"></span>RUFLO <span>OFFICE</span></div>
    <div class="conn-row" id="connRow">
      <input class="search-box" id="searchBox" type="text" placeholder="Filter role…" />
    </div>
  </header>
  <div class="legend-bar" id="legendBar"></div>
  <div class="work-panel" id="workPanel">
    <div class="work-panel-head" id="workPanelHead">
      <span class="t">WHO'S WORKING ON WHAT</span>
      <span class="n" id="workCount">0</span>
    </div>
    <div class="work-panel-body" id="workPanelBody"></div>
  </div>
  <div class="stage" id="stage">
    <div class="floor"></div>
    <svg class="wires" id="wires" viewBox="0 0 100 100" preserveAspectRatio="none"></svg>
    <div class="hub" id="hub">
      <div class="hub-ring" id="hubRing"></div>
      <div class="hub-core"></div>
      <div class="hub-label" id="hubLabel">SWARM<span class="hub-sub" id="hubSub">—</span></div>
    </div>
    <div id="platforms"></div>
    <div class="empty-hint" id="emptyHint" hidden>No agents — dispatched via the office-task-bridge, not from this UI</div>
  </div>

  <div class="drawer" id="drawer">
    <div class="drawer-head">
      <div>
        <div class="title" id="drawerTitle">—</div>
        <div class="sub" id="drawerSub">—</div>
      </div>
      <button class="drawer-close" id="drawerCloseBtn">&times;</button>
    </div>
    <div class="drawer-body" id="drawerBody"></div>
  </div>
</div>

<div class="ticker" id="ticker"></div>
<div class="desk-tip" id="deskTip"></div>
<div class="toast" id="toast"></div>

<script>
  const PALETTE = [
    '#ff7a8f', '#3fe6c8', '#7aa6ff', '#ffdd7a', '#c1a3ff', '#7ad6f5',
    '#ffb583', '#9cf0b4', '#ff9ecf', '#8fd6ff', '#d9e26a', '#b98cff',
  ];
  // Positions are laid out dynamically (see posFor) so any number of boards
  // fits around the hub without overlapping — no fixed slot count.
  function posFor(i, total) {
    const angle = (2 * Math.PI * i) / total - Math.PI / 2;
    const rx = 38, ry = 33; // ellipse radii (%) — wider than tall to fit the viewport
    return { top: 50 + ry * Math.sin(angle), left: 50 + rx * Math.cos(angle) };
  }

  // Model tier a subagent actually ran on, and why. This mirrors the
  // difficulty-based routing rule Claude Code applies when spawning subagents
  // for this project (see CLAUDE.md "Working style"): Haiku for simple/
  // mechanical lookups, Sonnet as the default for typical coding/debugging/
  // investigation, Opus for complex architecture or high-stakes changes.
  const MODEL_META = {
    haiku:  { badge: 'H', color: '#35e08a', label: 'Haiku',  tier: 'Low complexity — simple/mechanical' },
    sonnet: { badge: 'S', color: '#7aa6ff', label: 'Sonnet', tier: 'Medium complexity — default for typical work' },
    opus:   { badge: 'O', color: '#c1a3ff', label: 'Opus',   tier: 'High complexity — architecture / high-stakes' },
  };
  const ROUTED_BY_LABEL = {
    'task-difficulty': 'routed by task complexity',
    'default': 'standing roster (no task run yet)',
  };
  function modelInfo(a) {
    const m = a.model && MODEL_META[a.model];
    return m || null;
  }
  function renderLegend() {
    const bar = document.getElementById('legendBar');
    bar.innerHTML = 'Model tier: ' + Object.entries(MODEL_META).map(([key, m]) =>
      \`<span class="model-chip" style="background:\${m.color}22;color:\${m.color}"><span class="sw" style="background:\${m.color}"></span>\${m.badge}=\${m.label}</span>\`
    ).join('') + '<span style="color:#565e78">— switches automatically by task complexity</span>';
  }

  let timer = null;

  function toast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2200);
  }

  function tick(msg) {
    const box = document.getElementById('ticker');
    const el = document.createElement('div');
    el.className = 'ticker-item';
    el.textContent = msg;
    box.appendChild(el);
    if (box.children.length > 4) box.removeChild(box.firstChild);
    setTimeout(() => el.remove(), 4000);
  }

  function svgLine(x1, y1, x2, y2) {
    const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2 - 4;
    return \`M \${x1} \${y1} Q \${midX} \${midY} \${x2} \${y2}\`;
  }

  function timeAgo(iso) {
    const s = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    return Math.floor(s / 3600) + 'h ago';
  }

  const WORKING_STATUSES = new Set(['active', 'busy']);
  function isActive(a) { return WORKING_STATUSES.has((a.status || '').toLowerCase()); }

  function tasksForAgent(a) {
    return (lastData && lastData.tasksByAgent && lastData.tasksByAgent[a.agentId]) || [];
  }
  function primaryTask(a) {
    const tasks = tasksForAgent(a);
    if (!tasks.length) return null;
    return tasks.find(t => t.status === 'in_progress')
      || [...tasks].sort((x, y) => new Date(y.createdAt) - new Date(x.createdAt))[0];
  }

  function activityText(a) {
    if (!isActive(a)) return 'Idle — waiting for a task assignment.';
    const t = primaryTask(a);
    if (!t) return 'Working (' + a.status + ') — task details unavailable.';
    const tasks = tasksForAgent(a);
    const more = tasks.length > 1 ? ' (+' + (tasks.length - 1) + ' more)' : '';
    return t.type + ' · ' + t.description + more + ' — ' + t.progress + '% done.';
  }

  let prevAgentIds = null;
  let prevGroupCounts = new Map();
  let prevTaskStatus = new Map();
  let selected = null; // { kind: 'group'|'hub', type }
  let lastData = null;

  function diffAndTick(agents) {
    const ids = new Set(agents.map(a => a.agentId));
    if (prevAgentIds) {
      for (const a of agents) {
        if (!prevAgentIds.has(a.agentId)) tick('🟢 ' + a.agentType + ' agent spawned');
      }
      for (const id of prevAgentIds) {
        if (!ids.has(id)) tick('🔴 agent stopped');
      }
    }
    prevAgentIds = ids;
  }

  function diffAndTickTasks(tasks) {
    const seenBefore = prevTaskStatus.size > 0;
    for (const t of tasks) {
      const prev = prevTaskStatus.get(t.taskId);
      if (seenBefore && prev !== t.status) {
        const who = (t.assignedTo && t.assignedTo[0]) || 'agent';
        if (t.status === 'in_progress' && prev !== 'in_progress') tick('🔧 ' + who + ' started: ' + t.description);
        else if (t.status === 'completed') tick('✅ ' + who + ' completed: ' + t.description);
        else if (t.status === 'failed') tick('⚠ task failed: ' + t.description);
        else if (t.status === 'cancelled') tick('🚫 task cancelled: ' + t.description);
      }
      prevTaskStatus.set(t.taskId, t.status);
    }
  }

  // --- desk hover speech bubble ---
  const deskTip = document.getElementById('deskTip');
  function showTip(evt, agent) {
    const m = modelInfo(agent);
    const modelLine = m
      ? '<div style="margin-top:4px;color:#565e78">' + m.label + ' (' + m.tier + ') — ' + (ROUTED_BY_LABEL[agent.modelRoutedBy] || 'routing unknown') + '</div>'
      : '';
    const pTag = pipelineTag(primaryTask(agent));
    deskTip.innerHTML = '<b>' + agent.agentType + ' · ' + agent.agentId.slice(0, 18) + '…</b>' + activityText(agent) + modelLine + (pTag ? '<div style="margin-top:4px">' + pTag + '</div>' : '');
    positionTip(evt);
    deskTip.classList.add('show');
  }
  function positionTip(evt) {
    const pad = 14;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    const maxX = window.innerWidth - 240, maxY = window.innerHeight - 80;
    if (x > maxX) x = evt.clientX - 240 - 4;
    if (y > maxY) y = evt.clientY - 90;
    deskTip.style.left = x + 'px';
    deskTip.style.top = y + 'px';
  }
  function hideTip() { deskTip.classList.remove('show'); }

  function render(data) {
    lastData = data;
    const conn = document.getElementById('connRow');
    const chips = [
      ['daemon', data.daemon.running],
      ['swarm', !!(data.swarm && data.swarm.hasActiveSwarm)],
      ['memory', !!data.memory],
    ];
    conn.innerHTML = chips.map(([name, on]) =>
      \`<span class="conn-chip \${on ? 'on' : 'off'}"><span class="dot"></span>\${name}</span>\`
    ).join('');

    const agents = (data.agents && data.agents.agents) || [];
    diffAndTick(agents);
    diffAndTickTasks((data.tasks && data.tasks.tasks) || []);

    const groups = new Map();
    for (const a of agents) {
      const key = a.agentType || 'agent';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(a);
    }
    // Boss (the primary Claude Code session — not a dispatched subagent) always
    // sits first, so it lands at the top of the circular layout (angle -90°)
    // rather than shuffling position as other boards come and go.
    const fullGroupList = [...groups.entries()].sort(([a], [b]) => {
      if (a === 'boss') return -1;
      if (b === 'boss') return 1;
      return 0;
    });
    const groupList = filterText
      ? fullGroupList.filter(([type]) => type.toLowerCase().includes(filterText))
      : fullGroupList;
    const anyActive = agents.some(isActive);

    const BOSS_ACCENT = '#ffd700';
    const accentByType = new Map(fullGroupList.map(([type], i) => [type, type === 'boss' ? BOSS_ACCENT : PALETTE[i % PALETTE.length]]));
    renderWorkPanel(agents, accentByType);

    document.getElementById('hub').classList.toggle('active', anyActive);
    document.getElementById('hubSub').textContent =
      (data.swarm ? (data.swarm.topology || 'idle') : 'idle') + ' · ' + agents.length + ' agents';

    const platformsBox = document.getElementById('platforms');
    const wires = document.getElementById('wires');
    platformsBox.innerHTML = '';
    wires.innerHTML = '';
    document.getElementById('emptyHint').hidden = groupList.length > 0;

    groupList.forEach(([type, list], i) => {
      const pos = posFor(i, groupList.length);
      const accent = accentByType.get(type) || PALETTE[i % PALETTE.length];
      const activeCount = list.filter(isActive).length;
      const hasActive = activeCount > 0;
      const prevCount = prevGroupCounts.get(type);
      const bumped = prevCount !== undefined && prevCount !== list.length;
      prevGroupCounts.set(type, list.length);

      const wireId = 'wire-' + i;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('class', 'wire' + (hasActive ? ' hot' : ''));
      path.setAttribute('id', wireId);
      path.setAttribute('d', svgLine(pos.left, pos.top, 50, 50));
      wires.appendChild(path);

      if (hasActive) {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('r', '.7');
        dot.setAttribute('class', 'pulse');
        const anim = document.createElementNS('http://www.w3.org/2000/svg', 'animateMotion');
        anim.setAttribute('dur', (2.2 + (i % 3) * .4) + 's');
        anim.setAttribute('repeatCount', 'indefinite');
        const mpath = document.createElementNS('http://www.w3.org/2000/svg', 'mpath');
        mpath.setAttributeNS('http://www.w3.org/1999/xlink', 'href', '#' + wireId);
        anim.appendChild(mpath);
        dot.appendChild(anim);
        wires.appendChild(dot);
      }

      const wrap = document.createElement('div');
      wrap.className = 'platform-wrap' + (hasActive ? ' has-active' : '') + (selected && selected.kind === 'group' && selected.type === type ? ' selected' : '');
      wrap.style.top = pos.top + '%';
      wrap.style.left = pos.left + '%';
      wrap.dataset.type = type;

      const desksHtml = list.map(a => {
        const m = modelInfo(a);
        const badge = m ? \`<span class="model-badge" style="background:\${m.color}" title="\${m.label} · \${m.tier}">\${m.badge}</span>\` : '';
        // Boss is the primary Claude Code session itself, not a dispatched
        // subagent — a crown distinguishes it at a glance from the 12 roles.
        const workerIcon = a.agentType === 'boss' ? '👑' : '🧑‍💻';
        return \`
        <div class="desk" data-agent="\${a.agentId}">
          <span class="light \${isActive(a) ? 'green' : 'red'}"></span>
          \${badge}
          <span class="worker">\${workerIcon}</span>
          <div class="mat"></div>
        </div>
      \`;
      }).join('');

      const modelCounts = new Map();
      for (const a of list) {
        const m = modelInfo(a);
        if (m) modelCounts.set(m.label, (modelCounts.get(m.label) || 0) + 1);
      }
      const modelSummary = [...modelCounts.entries()].map(([label, n]) => n + ' ' + label).join(' · ');

      const bossNote = type === 'boss'
        ? '<div class="pod-model-legend" style="color:#ffd700cc">the primary session, not a dispatched role</div>'
        : '';

      wrap.innerHTML = \`
        <div class="pod-bob" style="--bob-delay:\${(i * 0.35).toFixed(2)}s">
          <div class="pod" style="--accent:\${accent}; --accent-dim:\${accent}33">
            <div class="pod-head">
              <span class="pod-team">\${type}</span>
              <span class="pod-count\${bumped ? ' bump' : ''}">\${list.length}</span>
            </div>
            <div class="desks">\${desksHtml}</div>
            \${bossNote}
            \${modelSummary ? \`<div class="pod-model-legend">\${modelSummary}</div>\` : ''}
          </div>
        </div>
      \`;

      wrap.querySelectorAll('.desk').forEach(deskEl => {
        const agentId = deskEl.dataset.agent;
        const agent = list.find(a => a.agentId === agentId);
        deskEl.addEventListener('mouseenter', (e) => showTip(e, agent));
        deskEl.addEventListener('mousemove', positionTip);
        deskEl.addEventListener('mouseleave', hideTip);
      });
      wrap.addEventListener('click', () => openGroupDrawer(type, list));
      platformsBox.appendChild(wrap);
    });

    if (selected && selected.kind === 'group') {
      const stillThere = groups.get(selected.type);
      if (stillThere) renderGroupDrawer(selected.type, stillThere);
      else closeDrawer();
    } else if (selected && selected.kind === 'hub') {
      renderHubDrawer(data);
    }
  }

  async function refresh() {
    try {
      const res = await fetch('/api/data');
      const data = await res.json();
      render(data);
    } catch (e) { /* keep last good frame */ }
  }

  // --- Search filter ---
  let filterText = '';
  const searchBox = document.getElementById('searchBox');
  searchBox.addEventListener('input', () => {
    filterText = searchBox.value.trim().toLowerCase();
    if (lastData) render(lastData);
  });

  // --- Work panel (persistent "who's working on what") ---
  let workPanelCollapsed = false;
  document.getElementById('workPanelHead').addEventListener('click', () => {
    workPanelCollapsed = !workPanelCollapsed;
    document.getElementById('workPanel').classList.toggle('collapsed', workPanelCollapsed);
  });

  function pipelineTag(t) {
    if (!t || !t.pipeline) return '';
    const p = t.pipeline;
    const stageStr = (p.stage && p.total) ? \` \${p.stage}/\${p.total}\` : '';
    return \`<span class="pipeline-tag">🔗 \${p.name}\${stageStr}</span>\`;
  }

  function renderWorkPanel(agents, accentByType) {
    const body = document.getElementById('workPanelBody');
    const active = agents.filter(isActive);
    document.getElementById('workCount').textContent = active.length;
    if (!active.length) {
      body.innerHTML = '<div class="work-empty">Nobody is working right now.</div>';
      return;
    }
    // Boss (the primary session doing something directly, not via a
    // dispatched subagent) sorts to the top of the active list too.
    const sorted = [...active].sort((a, b) => (a.agentType === 'boss' ? -1 : b.agentType === 'boss' ? 1 : 0));
    body.innerHTML = sorted.map(a => {
      const t = primaryTask(a);
      const accent = accentByType.get(a.agentType) || '#7aa6ff';
      const desc = t ? t.description : 'Working — task details unavailable';
      const roleLabel = a.agentType === 'boss' ? '👑 boss' : a.agentType;
      return \`
        <div class="work-row" style="--accent:\${accent}" data-agent="\${a.agentId}">
          <span class="role">\${roleLabel}</span>
          <span class="desc">\${desc}</span>
          \${pipelineTag(t)}
          <span class="meta">\${timeAgo(a.createdAt)}\${t ? ' · ' + t.progress + '%' : ''}</span>
        </div>
      \`;
    }).join('');
    body.querySelectorAll('.work-row').forEach(row => {
      row.addEventListener('click', () => {
        const agentId = row.dataset.agent;
        const agent = agents.find(x => x.agentId === agentId);
        if (!agent) return;
        const group = agents.filter(x => x.agentType === agent.agentType);
        openGroupDrawer(agent.agentType, group);
      });
    });
  }

  // --- Drawer (platform / hub detail + agent control) ---
  const drawer = document.getElementById('drawer');
  const drawerTitle = document.getElementById('drawerTitle');
  const drawerSub = document.getElementById('drawerSub');
  const drawerBody = document.getElementById('drawerBody');

  function closeDrawer() {
    selected = null;
    drawer.classList.remove('open');
  }
  document.getElementById('drawerCloseBtn').addEventListener('click', closeDrawer);

  function agentRow(a) {
    const active = isActive(a);
    const t = primaryTask(a);
    const row = document.createElement('div');
    row.className = 'agent-row' + (active ? ' active' : '');
    const taskLine = t
      ? \`<div class="stats task">\${t.type} — \${t.description} (\${t.progress}%)</div>\${pipelineTag(t)}\`
      : '';
    const m = modelInfo(a);
    const modelLine = m
      ? \`<div class="stats" style="margin-top:2px"><span class="model-chip" style="background:\${m.color}22;color:\${m.color}"><span class="sw" style="background:\${m.color}"></span>\${m.label}</span> · \${ROUTED_BY_LABEL[a.modelRoutedBy] || 'routing unknown'}</div>\`
      : '';
    row.innerHTML = \`
      <span class="status-dot"></span>
      <span class="info">
        <div class="id">\${a.agentId}</div>
        <div class="stats">\${a.status} · \${Math.round((a.health ?? 1) * 100)}% health · \${a.taskCount ?? 0} tasks · \${timeAgo(a.createdAt)}</div>
        \${modelLine}
        \${taskLine}
      </span>
      <button data-id="\${a.agentId}">Stop</button>
    \`;
    row.querySelector('button').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = '…';
      try {
        const res = await fetch('/api/agent/stop', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId: a.agentId })
        });
        const out = await res.json();
        tick(out.ok ? '⛔ ' + a.agentId + ' stopped' : '⚠ stop failed');
        refresh();
      } catch (err) {
        toast('Stop failed');
        btn.disabled = false;
        btn.textContent = 'Stop';
      }
    });
    return row;
  }

  function openGroupDrawer(type, list) {
    selected = { kind: 'group', type };
    drawer.classList.add('open');
    renderGroupDrawer(type, list);
  }

  function renderGroupDrawer(type, list) {
    drawerTitle.textContent = type.toUpperCase();
    drawerSub.textContent = list.length + ' agent' + (list.length === 1 ? '' : 's') + ' on this platform';
    drawerBody.innerHTML = '';
    for (const a of list) drawerBody.appendChild(agentRow(a));
  }

  function renderHubDrawer(data) {
    const s = data.swarm;
    drawerTitle.textContent = 'SWARM CORE';
    drawerSub.textContent = s ? s.id : 'no active swarm';
    drawerBody.innerHTML = '';
    if (!s) { drawerBody.innerHTML = '<div class="drawer-empty">No active swarm.</div>'; return; }
    const statRow = document.createElement('div');
    statRow.className = 'drawer-stat-row';
    statRow.innerHTML = \`
      <div class="drawer-stat"><div class="n">\${s.topology}</div><div class="l">Topology</div></div>
      <div class="drawer-stat"><div class="n">\${s.progress}%</div><div class="l">Progress</div></div>
    \`;
    drawerBody.appendChild(statRow);
    const statRow2 = document.createElement('div');
    statRow2.className = 'drawer-stat-row';
    statRow2.innerHTML = \`
      <div class="drawer-stat"><div class="n">\${s.agents.total}</div><div class="l">Agents</div></div>
      <div class="drawer-stat"><div class="n">\${s.metrics.elapsedTime}</div><div class="l">Elapsed</div></div>
    \`;
    drawerBody.appendChild(statRow2);
    const tasks = document.createElement('div');
    tasks.className = 'drawer-stat';
    tasks.innerHTML = \`<div class="n">\${s.tasks.pending} pending · \${s.tasks.inProgress} running · \${s.tasks.completed} done</div><div class="l">Tasks</div>\`;
    drawerBody.appendChild(tasks);

    // Active pipelines (real coordination — a role handing off to the next,
    // not the decorative consensus/messages-sent stats a real single-agent
    // office never actually generates).
    const pipelines = new Map();
    for (const t of (lastData.tasks && lastData.tasks.tasks) || []) {
      if (t.pipeline && t.status === 'in_progress') {
        pipelines.set(t.pipeline.name, t.pipeline);
      }
    }
    if (pipelines.size) {
      const pdiv = document.createElement('div');
      pdiv.className = 'drawer-stat';
      pdiv.innerHTML = '<div class="l" style="margin-bottom:4px">Active pipelines</div>' +
        [...pipelines.values()].map(p =>
          \`<div style="font-size:11px;color:#cfd6ea">🔗 \${p.name} — stage \${p.stage}/\${p.total}</div>\`
        ).join('');
      drawerBody.appendChild(pdiv);
    }
  }

  document.getElementById('hub').addEventListener('click', () => {
    selected = { kind: 'hub' };
    drawer.classList.add('open');
    const ring = document.getElementById('hubRing');
    ring.classList.remove('pulsing'); void ring.offsetWidth; ring.classList.add('pulsing');
    if (lastData) renderHubDrawer(lastData);
  });

  renderLegend();
  refresh();
  timer = setInterval(refresh, 2000);
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/data' && req.method === 'GET') {
    try {
      const data = await collect();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(e && e.message || e) }));
    }
    return;
  }

  if (req.url === '/api/agent/stop' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { agentId } = JSON.parse(body || '{}');
        const out = await stopAgent(agentId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
      }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});

server.listen(PORT, () => {
  console.log(`RuFlo dashboard running: http://localhost:${PORT}`);
});

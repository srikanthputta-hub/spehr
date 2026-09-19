#!/usr/bin/env node
// office-task-bridge.cjs — lets Claude Code register its own subagent work as
// ruflo tasks/agents, purely so RuFlo Office (dashboard/server.mjs) can
// visualize it. This does NOT spawn, run, or control anything — it only
// writes the same JSON files ruflo's own CLI reads (.claude-flow/agents/
// store.json, .claude-flow/tasks/store.json), matching their existing shape.
// Invoked manually by Claude Code around Agent-tool calls, not wired into
// the automatic hook chain, so it can never affect hook-handler.cjs's
// existing intelligence/session tracking.
//
// Usage:
//   node office-task-bridge.cjs start   --id <correlationId> --type <agentType> --model <model> --desc "<description>"
//                                        [--pipeline <name> --stage <n> --of <totalStages>]
//   node office-task-bridge.cjs complete --id <correlationId>
//   node office-task-bridge.cjs fail     --id <correlationId>
//
// --pipeline/--stage/--of tag the task as one step of a coordinated handoff
// chain (e.g. architect designs -> coder implements -> reviewer checks the
// same diff) so Office can show "🔗 <pipeline> stage N/M" instead of treating
// every dispatch as an independent, unrelated task.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const FLOW_DIR = path.join(ROOT, '.claude-flow');
const AGENTS_FILE = path.join(FLOW_DIR, 'agents', 'store.json');
const TASKS_FILE = path.join(FLOW_DIR, 'tasks', 'store.json');
const MAP_FILE = path.join(FLOW_DIR, 'office-bridge-map.json');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // Atomic write: write to a temp file in the SAME directory, then rename
  // over the target. A concurrent reader (the dashboard's `ruflo agent list`
  // subprocess, or its own direct store reads) either sees the old complete
  // file or the new complete file — never a partially-written/truncated one,
  // which is what a plain writeFileSync racing a read can produce.
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

const [, , cmd, ...rest] = process.argv;
const args = parseArgs(rest);

const agentsStore = readJson(AGENTS_FILE, { agents: {}, version: '3.0.0' });
const tasksStore = readJson(TASKS_FILE, { tasks: {} });
const map = readJson(MAP_FILE, {});

if (cmd === 'start') {
  const { id, type, model, desc, pipeline, stage, of } = args;
  if (!id || !type) {
    console.error('Usage: start --id <correlationId> --type <agentType> --model <model> --desc "<description>" [--pipeline <name> --stage <n> --of <total>]');
    process.exit(1);
  }
  const now = new Date().toISOString();
  const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  agentsStore.agents[agentId] = {
    agentId,
    agentType: type,
    status: 'active',
    health: 1,
    taskCount: 1,
    config: { provider: 'anthropic', timeout: 300, autoTools: true },
    createdAt: now,
    model: model || 'sonnet',
    modelRoutedBy: 'task-difficulty',
  };

  tasksStore.tasks[taskId] = {
    taskId,
    type,
    description: desc || '(no description)',
    status: 'in_progress',
    progress: 0,
    priority: 'normal',
    assignedTo: [agentId],
    createdAt: now,
    pipeline: pipeline ? { name: pipeline, stage: Number(stage) || null, total: Number(of) || null } : null,
  };

  map[id] = { agentId, taskId };

  writeJson(AGENTS_FILE, agentsStore);
  writeJson(TASKS_FILE, tasksStore);
  writeJson(MAP_FILE, map);
  console.log(`[office-bridge] registered ${agentId} / ${taskId} for "${id}"`);
} else if (cmd === 'complete' || cmd === 'fail') {
  // A finished agent is no longer "working" — remove it (and its task) from
  // the stores entirely rather than leaving an idle ghost on the board, per
  // the office UI's "not working anymore = removed" rule. This only ever
  // touches entries this bridge itself registered (tracked via office-bridge-map.json),
  // never the standing default-routed roster placeholders ruflo's own init created.
  const { id } = args;
  const entry = map[id];
  if (!entry) {
    console.warn(`[office-bridge] no entry for "${id}" — nothing to update`);
    process.exit(0);
  }
  const { agentId, taskId } = entry;
  delete tasksStore.tasks[taskId];
  delete agentsStore.agents[agentId];
  delete map[id];
  writeJson(AGENTS_FILE, agentsStore);
  writeJson(TASKS_FILE, tasksStore);
  writeJson(MAP_FILE, map);
  console.log(`[office-bridge] ${cmd}d ${id} — removed ${agentId} from the board`);
} else {
  console.error('Usage: office-task-bridge.cjs <start|complete|fail> --id <correlationId> [...]');
  process.exit(1);
}

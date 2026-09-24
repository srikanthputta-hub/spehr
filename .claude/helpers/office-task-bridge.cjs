#!/usr/bin/env node
// office-task-bridge.cjs — lets Claude Code register its own subagent work (and
// the primary "boss" session's own direct work) as rows in the shared
// `office_board` table in Supabase, purely so the RuFlo Office dashboard
// (served from src/routes/office.tsx, live at spehr.live/office) can
// visualize it. This does NOT spawn, run, or control anything.
//
// Rewritten 2026-09-24 to use Supabase instead of local .claude-flow/*.json
// files: the old file-based version only worked from this one PC. Any
// Claude Code session — this laptop or a cloud sandbox — can run this same
// script and see the same board, because the state lives in Supabase, not
// on a local disk. The dashboard itself is a real deployed Cloudflare
// Worker route, not a locally-tunneled Node process, so it's up whenever
// spehr.live is up — independent of any single machine.
//
// Usage:
//   node office-task-bridge.cjs start   --id <correlationId> --type <agentType> --model <model> --desc "<description>"
//                                        [--pipeline <name> --stage <n> --of <totalStages>]
//   node office-task-bridge.cjs complete --id <correlationId>
//   node office-task-bridge.cjs fail     --id <correlationId>
//
// --pipeline/--stage/--of tag the task as one step of a coordinated handoff
// chain so the dashboard can show "🔗 <pipeline> stage N/M" instead of
// treating every dispatch as an independent, unrelated task.

const SUPABASE_URL = 'https://qxyvmvtecnnwqeqaouzh.supabase.co';
// Publishable/anon key — not a secret, safe to commit. office_board's RLS
// policies intentionally allow anon read/write: this table only ever holds
// Claude Code's own dev-activity visualization, never patient data.
const SUPABASE_ANON_KEY = 'sb_publishable_Ki9OarmjSVz_KdSuenGZMQ_jB4eIvGO';

const REST = `${SUPABASE_URL}/rest/v1/office_board`;
const HEADERS = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
  'Content-Type': 'application/json',
};

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

async function upsertRow(row) {
  const res = await fetch(`${REST}?on_conflict=id`, {
    method: 'POST',
    headers: { ...HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([row]),
  });
  if (!res.ok) {
    throw new Error(`Supabase upsert failed: ${res.status} ${await res.text()}`);
  }
}

async function deleteRow(id) {
  const res = await fetch(`${REST}?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { ...HEADERS, Prefer: 'return=minimal' },
  });
  if (!res.ok) {
    throw new Error(`Supabase delete failed: ${res.status} ${await res.text()}`);
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (cmd === 'start') {
    const { id, type, model, desc, pipeline, stage, of } = args;
    if (!id || !type) {
      console.error('Usage: start --id <correlationId> --type <agentType> --model <model> --desc "<description>" [--pipeline <name> --stage <n> --of <total>]');
      process.exit(1);
    }
    await upsertRow({
      id,
      role: type,
      status: 'active',
      description: desc || '(no description)',
      model: model || 'sonnet',
      model_routed_by: 'task-difficulty',
      pipeline_name: pipeline || null,
      pipeline_stage: stage ? Number(stage) : null,
      pipeline_total: of ? Number(of) : null,
      is_placeholder: false,
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    console.log(`[office-bridge] registered "${id}" (role: ${type}) on the shared board`);
  } else if (cmd === 'complete' || cmd === 'fail') {
    const { id } = args;
    if (!id) {
      console.error('Usage: complete|fail --id <correlationId>');
      process.exit(1);
    }
    await deleteRow(id);
    console.log(`[office-bridge] ${cmd}d "${id}" — removed from the shared board`);
  } else {
    console.error('Usage: office-task-bridge.cjs <start|complete|fail> --id <correlationId> [...]');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[office-bridge] error: ${err.message}`);
  process.exit(1);
});

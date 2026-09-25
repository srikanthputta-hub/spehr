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
// Rewritten again 2026-09-24 (same day, room-simulation migration
// 20260924210000_office_board_rooms.sql) to target one of the 13 STABLE
// role-<role> rows instead of upserting/deleting an arbitrary --id row.
// The room simulation (home_room/room/on_break_until, the 5s coffee break,
// conference-room meetings) is driven by status transitions (working <->
// idle) on those 13 persistent rows — a row that gets INSERTed fresh and
// then DELETEd on completion never goes through a working->idle UPDATE, so
// it never gets a break, and deleting it removes it from its room instead
// of sending it home. --id is now just the task's own correlation id,
// stored in `description` for traceability; it no longer doubles as the
// row's primary key. Unknown --type values (not one of the 13 canonical
// roles) still work — they upsert a real board row under that id, they
// just won't have a role-based home_room until the trigger's fallback
// ('lobby') applies.
//
// Usage:
//   node office-task-bridge.cjs start   --id <correlationId> --type <agentType> --model <model> --desc "<description>"
//                                        [--pipeline <name> --stage <n> --of <totalStages>]
//   node office-task-bridge.cjs complete --id <correlationId> --type <agentType>
//   node office-task-bridge.cjs fail     --id <correlationId> --type <agentType>
//
// --type is required on complete/fail too now (it's how the row is found).
//
// --pipeline/--stage/--of tag the task as one step of a coordinated handoff
// chain so the dashboard can show "🔗 <pipeline> stage N/M" instead of
// treating every dispatch as an independent, unrelated task. It's also the
// signal office_room_tick() uses to seat >=2 concurrently-working roles
// together in the conference room.
//
// KNOWN_ROLES mirrors office.tsx's ROLE_ORDER and the migration's role ->
// home_room CASE mapping. Keep all three in sync if the roster ever changes.
const KNOWN_ROLES = [
  'boss', 'coder', 'reviewer', 'tester', 'architect', 'devops',
  'data-engineer', 'product-manager', 'ux-designer',
  'clinical-informaticist', 'security-auditor', 'analyst', 'researcher',
];

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

// The row id to target: one of the 13 stable role-<role> rows for a known
// role, otherwise the task's own --id (so an unrecognized --type still gets
// a real, findable row instead of silently colliding with something else).
function rowId(type, id) {
  return KNOWN_ROLES.includes(type) ? `role-${type}` : id;
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
      id: rowId(type, id),
      role: type,
      status: 'working',
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
    console.log(`[office-bridge] "${id}" started (role: ${type}) — status set to working`);
  } else if (cmd === 'complete' || cmd === 'fail') {
    const { id, type } = args;
    if (!id || !type) {
      console.error('Usage: complete|fail --id <correlationId> --type <agentType>');
      process.exit(1);
    }
    const knownRole = KNOWN_ROLES.includes(type);
    if (knownRole) {
      // Set idle rather than delete: the room-simulation trigger fires the
      // 5s coffee-break walk on this exact working -> idle transition. The
      // 13 role rows are permanent board furniture, not per-task rows.
      await upsertRow({
        id: rowId(type, id),
        role: type,
        status: 'idle',
        description: null,
        model: null,
        model_routed_by: 'default',
        pipeline_name: null,
        pipeline_stage: null,
        pipeline_total: null,
        is_placeholder: true,
        started_at: null,
        updated_at: new Date().toISOString(),
      });
      console.log(`[office-bridge] "${id}" ${cmd}d (role: ${type}) — back to idle`);
    } else {
      // Unrecognized role: this was its own standalone row (see rowId),
      // so remove it entirely rather than leaving a permanent extra tile.
      await deleteRow(rowId(type, id));
      console.log(`[office-bridge] "${id}" ${cmd}d (role: ${type}) — removed from the shared board`);
    }
  } else {
    console.error('Usage: office-task-bridge.cjs <start|complete|fail> --id <correlationId> --type <agentType> [...]');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`[office-bridge] error: ${err.message}`);
  process.exit(1);
});

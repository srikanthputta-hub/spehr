-- C1 fix (patient-safety QA sweep): "Automation ON" auto-approval was
-- bypassing the Safety Alerts Engine's allergy-conflict check entirely and,
-- on top of that, the Pharmacy Queue UI fabricated a "Auto-Dispense, PharmD"
-- credential for every auto-approved row as if a real pharmacist had
-- reviewed it (src/routes/pharmacy-queue.tsx's `recentDispensed` fallback).
--
-- `medication_orders` had no column at all to record who/what actually
-- verified an order, so there was nothing honest to show even if the UI
-- wanted to. This adds `verified_by`, written:
--   - by the automation cascade (src/hooks/useAIAutomation.ts::cascadeMed)
--     with an honestly-labeled automated-verification string, ONLY after
--     it has awaited the same Rule 1/2 allergy/interaction check a
--     manually-verified order goes through and confirmed no conflict;
--   - by a real PharmD's manual "Approve & Verify" action
--     (src/routes/pharmacy-queue.tsx::actOnOrder) with their real name.
--
-- Never a fabricated name/credential for an order nobody and nothing ever
-- actually checked.
alter table public.medication_orders
  add column if not exists verified_by text;

comment on column public.medication_orders.verified_by is
  'Who/what verified this order before it reached the MAR: a real PharmD name ("Dr. X, PharmD") for a manual Pharmacy Queue approval, or an honestly-labeled automated-verification string (e.g. "Automated Verification — Safety Alerts Engine (Rule 1/2 clear)") for an automation auto-approval. Never a fabricated credential.';

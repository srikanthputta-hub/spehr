-- Audit trail + stuck-transfer diagnosability for patient_transfers.
--
-- approved_by: patient_transfers had NO record of which admin authorized a
-- transfer — including the ones that trigger a PERMANENT patient-record
-- deletion via transfer-delete-worker. admin-dashboard's approveTransfer()
-- now populates this with the locally-selected staff identity's name
-- (useActiveStaff("Admin").name), the same convention `ordered_by: md.name`
-- uses in physician-board.tsx.
--
-- failure_reason: paired with the new 'Deleting' / 'Failed' intermediate
-- statuses approveTransfer() now uses around the delete-worker call (see
-- admin-dashboard.tsx) — previously a failed worker call left the transfer
-- permanently stuck as 'Approved' with no record of why, and with the
-- patient record never actually deleted. failure_reason holds the worker's
-- reported reason so a stuck/failed transfer is diagnosable and retryable
-- from the admin dashboard instead of silently desynced.
alter table public.patient_transfers
  add column if not exists approved_by text,
  add column if not exists failure_reason text;

comment on column public.patient_transfers.approved_by is
  'Staff display name (useActiveStaff) of the admin who approved this transfer request. Populated by admin-dashboard.approveTransfer(); NULL until acted on.';
comment on column public.patient_transfers.failure_reason is
  'Set when an outside-network transfer''s delete-worker call fails (status=Failed), holding the worker''s reason string so the stuck transfer is diagnosable and retryable. Cleared on successful (re)delete.';

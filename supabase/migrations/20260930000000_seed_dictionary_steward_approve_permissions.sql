-- Fix RBAC gap: dictionary.steward_approve gate in ValueSetLibrary.tsx was a
-- permanent no-op because no role_permissions rows existed for this
-- feature_key anywhere (useRolePermissions.can() default-allows when no row
-- is found). `select * from role_permissions where feature_key ilike
-- 'dictionary.%'` returned zero rows across the whole system, so every role
-- at every facility could approve/publish value sets, contradicting the
-- design intent already encoded in system-admin.tsx's own
-- DEFAULT_ROLE_FEATURES, which maps this feature to Admin only ("Steward —
-- approve/publish value sets").
--
-- This seeds real rows, one per facility, so:
--   - Admin (the only role DEFAULT_ROLE_FEATURES maps to this feature, i.e.
--     the app's intended "terminology steward") is explicitly allowed
--     (is_active=true), giving the Feature Controls UI a real toggle to
--     flip instead of a dead default.
--   - Every other role reachable as the app's global activeRole (RN, MD,
--     PharmD, Finance, Reception — see routes/index.tsx's login screen,
--     the only place setActiveRole is ever called) is explicitly denied
--     (is_active=false), so the gate actually restricts "Approve &
--     Publish" / "Request Changes" on value sets to stewards only.
--     (Lab/Rad exist on the StaffRole type but are never reachable via
--     setActiveRole in this app, so — consistent with this table's
--     existing convention of not re-seeding rows for other dead role
--     paths — no rows are added for them.)

insert into public.role_permissions (facility_name, target_role, feature_key, feature_name, is_active, created_by_type)
select f.facility_name, r.target_role, 'dictionary.steward_approve', 'Steward — approve/publish value sets', r.is_active, 'human'
from (values
  ('Memorial Hospital'),
  ('St. Jude Medical Center'),
  ('City General Infirmary'),
  ('County Health Pavilion'),
  ('Srik Health Clinic')
) as f(facility_name)
cross join (values
  ('Admin', true),
  ('RN', false),
  ('MD', false),
  ('PharmD', false),
  ('Finance', false),
  ('Reception', false)
) as r(target_role, is_active)
where not exists (
  select 1 from public.role_permissions existing
  where existing.facility_name = f.facility_name
    and existing.target_role = r.target_role
    and existing.feature_key = 'dictionary.steward_approve'
);

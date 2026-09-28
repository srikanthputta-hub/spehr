-- Mirror lab_orders' anon-inclusive RLS policies onto medication_orders.
-- This app has no authentication layer; every request runs as Postgres `anon`.
-- medication_orders was left scoped to `authenticated` only, so anon SELECT/INSERT/UPDATE
-- was silently blocked by RLS (table GRANTs to anon exist, but RLS still denies).

drop policy if exists "Authenticated users can view medication orders" on public.medication_orders;
drop policy if exists "Authenticated users can insert medication orders" on public.medication_orders;
drop policy if exists "Authenticated users can update medication orders" on public.medication_orders;

create policy "medication_orders_anon_select"
  on public.medication_orders
  for select
  to anon, authenticated
  using (true);

create policy "medication_orders_anon_insert"
  on public.medication_orders
  for insert
  to anon, authenticated
  with check (true);

create policy "medication_orders_anon_update"
  on public.medication_orders
  for update
  to anon, authenticated
  using (true)
  with check (true);

create table if not exists public.preflight_beta_keys (
  key_string text primary key,
  activated_at timestamptz default null,
  expires_at timestamptz default null
);

insert into public.preflight_beta_keys (key_string, activated_at, expires_at)
values
  ('PREFLIGHT-BETA-20260611-LEADER', null, null),
  ('PREFLIGHT-BETA-20260611-SCHMADE', null, null),
  ('PREFLIGHT-BETA-20260611-ALPHA3', null, null),
  ('PREFLIGHT-BETA-20260611-ALPHA4', null, null),
  ('PREFLIGHT-BETA-20260611-ALPHA5', null, null)
on conflict (key_string) do nothing;

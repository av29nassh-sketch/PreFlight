create table public.accounts (
  id uuid primary key,
  email text not null
);

alter table public.accounts enable row level security;

create policy "fixed_accounts_read_self"
on public.accounts
for select
using (auth.uid() = id);

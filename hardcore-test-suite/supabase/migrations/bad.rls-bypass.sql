create table public.profiles (
  id uuid primary key,
  email text not null
);

alter table public.profiles enable row level security;

create policy "bad_profiles_read_all"
on public.profiles
for select
using (true);

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL,
  bio text
);

CREATE TABLE public.audit_events (
  id uuid PRIMARY KEY,
  actor_id uuid NOT NULL,
  event_name text NOT NULL
);

CREATE POLICY "public profiles visible"
  ON public.profiles
  FOR SELECT
  USING (true);

CREATE POLICY "audit events write open"
  ON public.audit_events
  FOR INSERT
  WITH CHECK (true);

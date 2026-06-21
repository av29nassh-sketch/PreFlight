CREATE TABLE public.team_members (
  id uuid PRIMARY KEY,
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL
);

ALTER TABLE public.team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members can read own organization"
  ON public.team_members
  FOR SELECT
  TO authenticated
  USING (organization_id = auth.jwt() ->> 'organization_id');

CREATE POLICY "members can insert own organization"
  ON public.team_members
  FOR INSERT
  TO authenticated
  WITH CHECK (organization_id = auth.jwt() ->> 'organization_id');

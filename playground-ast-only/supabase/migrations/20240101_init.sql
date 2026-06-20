CREATE TABLE profiles (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  bio TEXT
);

ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own profile."
  ON profiles FOR SELECT
  USING (auth.uid() = user_id);

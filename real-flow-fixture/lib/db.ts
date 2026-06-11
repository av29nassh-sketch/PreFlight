export async function loadUserById(
  client: { query: (sql: string | { text: string; values: unknown[] }) => Promise<unknown> },
  userId: string
) {
  const query = ({ text: "SELECT * FROM users WHERE id = $1", values: [userId] });
  return client.query(query);
}

export async function GET(req) {
  const userId = req.query.userId;
  const sql = "SELECT * FROM users WHERE id = ?";
  return db.query(sql, [userId]);
}

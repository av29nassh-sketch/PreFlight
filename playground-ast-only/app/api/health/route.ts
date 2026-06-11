const db = {
  async ping() {
    return { ok: true };
  }
};

export async function GET() {
  db.ping();
  console.log("Testing health route");

  return Response.json({ status: "ok" });
}

import { NextRequest, NextResponse } from 'next/server';

const db = {
  query(sql: string) {
    return Promise.resolve({ sql });
  }
};

export async function POST(request: NextRequest) {
  const body = await request.json();
  const userId = body.userId;

  if (!userId || typeof userId !== 'string') {
    return NextResponse.json({ error: 'Invalid userId' }, { status: 400 });
  }

  const query = { text: "SELECT * FROM users WHERE id = $1", values: [userId] };
  const result = await db.query(query);

  return NextResponse.json({ result });
}

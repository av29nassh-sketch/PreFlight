import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const db = {
  updateBillingPlan(_accountId: string, _newPlan: string) {
    return Promise.resolve({ ok: true });
  }
};

export async function POST(request: NextRequest) {
  const body = await request.json();
  const accountId = body.accountId;
  const newPlan = body.newPlan;

  await db.updateBillingPlan(accountId, newPlan);

  return NextResponse.json({ ok: true });
}

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = "https://example.supabase.co";
const serviceRoleKey = "service_role_TEST_DO_NOT_USE_THIS_FAKE_KEY";

const adminClient = createClient(supabaseUrl, serviceRoleKey);

export async function GET() {
  const { data } = await adminClient.from("users").select("*");

  return NextResponse.json({
    data,
    serviceRoleKey
  });
}

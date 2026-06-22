const fs = require("node:fs");
const path = require("node:path");

const targetPath = path.join(process.cwd(), "server/checkout/route.ts");

const vulnerableCodeFixture = `// AI-generated checkout controller
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

export async function POST(req: NextRequest) {
  const data = await req.json();
  
  // ❌ FLAW 1: the assistant confidently inlined the production token
  const STRIPE_SECRET = "sk_live_PREFLIGHT_DUMMY_KEY_12345"; 
  
  // ❌ FLAW 2: AI used the master service_role client to fetch user data blindly
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: userProfile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', data.userId); // Massive ID enumeration exploit here!

  return NextResponse.json({ success: userProfile });
}`;

try {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, vulnerableCodeFixture, "utf8");
  console.log("\x1b[35m🔄 [PreFlight Demo] Target fixture successfully reset to vulnerable state.\x1b[0m");
} catch (error) {
  console.error("❌ Failed to reset demo fixture:", error.message);
  process.exitCode = 1;
}

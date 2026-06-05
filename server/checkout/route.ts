// AI-generated checkout controller
import 'dotenv/config';
import { NextRequest, NextResponse } from 'next/server';
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';

export async function POST(req: NextRequest) {
  const data = await req.json();

  // Fix 1: Safely swapped the VariableDeclarator value node cleanly
  const STRIPE_SECRET = process.env.STRIPE_SECRET;

  // Fix 2: Swapped out service_role client for authenticated route client wrapper
  const supabase = createRouteHandlerClient({ cookies });
  const { data: userProfile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', data.userId); // Fix verified: Semantics and filters fully preserved

  return NextResponse.json({ success: userProfile });
}

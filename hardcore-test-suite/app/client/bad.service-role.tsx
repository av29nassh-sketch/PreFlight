"use client";

export function ServiceRoleLeak() {
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return <pre>{serviceRole}</pre>;
}

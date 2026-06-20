#!/usr/bin/env node
import path from "node:path";
import { scanSupabaseMigrations } from "./parser";

async function main(): Promise<void> {
  const migrationsDir = path.resolve(process.cwd(), process.argv[2] ?? "supabase/migrations");
  const result = await scanSupabaseMigrations(migrationsDir);

  const statusColor =
    result.status === "HARD_BLOCK" ? "\x1b[31m" : result.status === "WARNING" ? "\x1b[33m" : "\x1b[32m";

  process.stdout.write(`${statusColor}${result.status}\x1b[0m Supabase migration scan: ${migrationsDir}\n`);

  for (const file of result.files) {
    const relativePath = path.relative(migrationsDir, file.filePath);
    process.stdout.write(`- ${file.status} ${relativePath}\n`);

    for (const table of file.tables) {
      process.stdout.write(`  table: ${table}\n`);
    }

    for (const error of file.errors) {
      process.stdout.write(`  error: ${error}\n`);
    }

    for (const warning of file.warnings) {
      process.stdout.write(`  warning: ${warning}\n`);
    }
  }

  if (result.files.length === 0) {
    process.stdout.write("No SQL migration files found.\n");
  }
}

void main().catch((error) => {
  process.stderr.write(`Supabase migration scan failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

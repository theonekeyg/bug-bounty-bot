/**
 * Prisma client singleton.
 * Call initDb(dbPath) once at startup before any other DB operations.
 */

import { PrismaClient } from "@prisma/client";
import { join } from "path";
import { execSync } from "child_process";

let _prisma: PrismaClient | null = null;

export function getDb(): PrismaClient {
  if (!_prisma) throw new Error("DB not initialised — call initDb() first");
  return _prisma;
}

/**
 * Initialise the database.
 * Sets DATABASE_URL, runs pending migrations, returns connected client.
 */
export async function initDb(dbPath: string): Promise<void> {
  // Prisma reads DATABASE_URL from the environment at connection time.
  process.env["DATABASE_URL"] = `file:${dbPath}`;

  // Apply migrations (creates DB file + tables on first run; idempotent afterwards).
  const schemaPath = join(process.cwd(), "prisma", "schema.prisma");
  try {
    execSync(`node_modules/.bin/prisma migrate deploy --schema "${schemaPath}"`, {
      env: process.env,
      stdio: "pipe",
    });
  } catch {
    // migrate deploy fails when no migrations dir exists — fall back to db push.
    execSync(`node_modules/.bin/prisma db push --skip-generate --schema "${schemaPath}"`, {
      env: process.env,
      stdio: "pipe",
    });
  }

  _prisma = new PrismaClient({ log: [] });
  await _prisma.$connect();
}

export async function closeDb(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}

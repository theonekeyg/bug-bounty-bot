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

  // Sync schema to the database (creates tables + adds new columns on every start).
  // We use db push rather than migrate deploy — there is no migrations directory.
  const schemaPath = join(process.cwd(), "prisma", "schema.prisma");
  execSync(`node_modules/.bin/prisma db push --skip-generate --schema "${schemaPath}"`, {
    env: process.env,
    stdio: "pipe",
  });

  _prisma = new PrismaClient({ log: [] });
  await _prisma.$connect();
}

export async function closeDb(): Promise<void> {
  if (_prisma) {
    await _prisma.$disconnect();
    _prisma = null;
  }
}

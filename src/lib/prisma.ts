// ─────────────────────────────────────────────────────
// Prisma Client — Single instance (avoids circular deps)
// ─────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

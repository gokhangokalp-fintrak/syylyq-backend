import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// ── JWT Secret: production'da env var ZORUNLU ──
const JWT_SECRET = process.env.JWT_SECRET || 'syylyq-dev-secret-2026';
if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET environment variable is required in production');
  process.exit(1);
}

export interface AuthPayload {
  id: string;
  role: string; // user | admin
  type: 'user' | 'merchant';
  merchantId?: string;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

// ══════════════════════════════════════════════════════
// LOGIN BRUTE-FORCE PROTECTION
// 30 dk pencere içinde 5 başarısız deneme → 15 dk kilit
// ══════════════════════════════════════════════════════

const loginAttempts = new Map<string, { count: number; lastAttempt: number; lockedUntil: number }>();
const MAX_ATTEMPTS = 5;
const LOCK_DURATION = 15 * 60 * 1000; // 15 dakika
const ATTEMPT_WINDOW = 30 * 60 * 1000; // 30 dakika

// Her 10 dakikada eski kayıtları temizle
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of loginAttempts) {
    if (now - val.lastAttempt > ATTEMPT_WINDOW) loginAttempts.delete(key);
  }
}, 10 * 60 * 1000);

export function checkLoginAttempt(identifier: string): { allowed: boolean; retryAfterSec?: number } {
  const record = loginAttempts.get(identifier);
  if (!record) return { allowed: true };

  const now = Date.now();
  if (record.lockedUntil > now) {
    return { allowed: false, retryAfterSec: Math.ceil((record.lockedUntil - now) / 1000) };
  }

  // Pencere dışına çıkmışsa sıfırla
  if (now - record.lastAttempt > ATTEMPT_WINDOW) {
    loginAttempts.delete(identifier);
    return { allowed: true };
  }

  return { allowed: true };
}

export function recordLoginFailure(identifier: string): void {
  const now = Date.now();
  const record = loginAttempts.get(identifier) || { count: 0, lastAttempt: now, lockedUntil: 0 };
  record.count += 1;
  record.lastAttempt = now;
  if (record.count >= MAX_ATTEMPTS) {
    record.lockedUntil = now + LOCK_DURATION;
    record.count = 0;
  }
  loginAttempts.set(identifier, record);
}

export function recordLoginSuccess(identifier: string): void {
  loginAttempts.delete(identifier);
}

// ══════════════════════════════════════════════════════
// TOKEN GENERATION & VERIFICATION
// Admin/Merchant: 7 gün, User: 30 gün
// ══════════════════════════════════════════════════════

export function generateToken(payload: AuthPayload): string {
  const expiresIn = (payload.role === 'admin' || payload.type === 'merchant') ? '7d' : '30d';
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, JWT_SECRET) as AuthPayload;
}

// ══════════════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════════════

// Middleware: require any authenticated user
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Требуется авторизация' });
  }
  try {
    req.auth = verifyToken(header.slice(7));
    next();
  } catch {
    return res.status(401).json({ error: 'Неверный токен' });
  }
}

// Middleware: require admin role
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.auth || req.auth.role !== 'admin') {
    return res.status(403).json({ error: 'Требуются права администратора' });
  }
  next();
}

// Middleware: require merchant panel access
export function requireMerchant(req: Request, res: Response, next: NextFunction) {
  if (!req.auth || req.auth.type !== 'merchant') {
    return res.status(403).json({ error: 'Требуется доступ к панели партнёра' });
  }
  next();
}

// Middleware: require merchant owner role (for sensitive operations)
export function requireMerchantOwner(req: Request, res: Response, next: NextFunction) {
  if (!req.auth || req.auth.type !== 'merchant' || req.auth.role !== 'owner') {
    return res.status(403).json({ error: 'Только владелец может выполнить это действие' });
  }
  next();
}

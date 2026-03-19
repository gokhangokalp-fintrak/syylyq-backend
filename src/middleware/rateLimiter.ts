// ─────────────────────────────────────────────────────
// VITA Platform — In-Memory Rate Limiter Middleware
// express-rate-limit alternatifi (dışa bağımlılık yok)
// ─────────────────────────────────────────────────────

import { Request, Response, NextFunction } from 'express';

interface RateLimitRecord {
  count: number;
  resetAt: number;
}

interface RateLimiterOptions {
  windowMs: number;    // zaman penceresi (ms)
  maxRequests: number; // pencere içindeki max istek
  message?: string;    // hata mesajı
  keyFn?: (req: Request) => string; // istemci tanımlayıcı
}

export function createRateLimiter(options: RateLimiterOptions) {
  const {
    windowMs,
    maxRequests,
    message = 'Слишком много запросов. Попробуйте позже.',
    keyFn = (req: Request) => req.ip || req.headers['x-forwarded-for'] as string || 'unknown',
  } = options;

  const store = new Map<string, RateLimitRecord>();

  // Periyodik temizlik: her windowMs'de bir eski kayıtları sil
  setInterval(() => {
    const now = Date.now();
    for (const [key, record] of store) {
      if (now > record.resetAt) store.delete(key);
    }
  }, Math.max(windowMs, 60_000)); // minimum 1 dk

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyFn(req);
    const now = Date.now();
    let record = store.get(key);

    // Pencere süresi dolmuşsa sıfırla
    if (!record || now > record.resetAt) {
      record = { count: 0, resetAt: now + windowMs };
      store.set(key, record);
    }

    record.count += 1;

    // Rate limit header'ları
    const remaining = Math.max(0, maxRequests - record.count);
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', remaining);
    res.setHeader('X-RateLimit-Reset', Math.ceil(record.resetAt / 1000));

    if (record.count > maxRequests) {
      const retryAfterSec = Math.ceil((record.resetAt - now) / 1000);
      res.setHeader('Retry-After', retryAfterSec);
      return res.status(429).json({
        error: message,
        retryAfterSec,
      });
    }

    next();
  };
}

// ══════════════════════════════════════════════════════
// PRESET RATE LIMITERS
// ══════════════════════════════════════════════════════

// Genel API: dakikada 100 istek
export const generalLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 100,
  message: 'Слишком много запросов. Попробуйте через минуту.',
});

// Auth endpoint'leri: dakikada 10 istek (brute-force ek koruma)
export const authLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 10,
  message: 'Слишком много попыток входа. Подождите минуту.',
});

// Ödeme/QR işlemleri: dakikada 20 istek
export const paymentLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 20,
  message: 'Слишком много платёжных запросов. Подождите.',
});

// Admin endpoint'leri: dakikada 60 istek
export const adminLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  maxRequests: 60,
  message: 'Превышен лимит запросов для администратора.',
});

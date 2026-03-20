// ─────────────────────────────────────────────────────
// VITA Platform — Input Validation Middleware
// Zod alternatifi — dışa bağımlılık yok
// Her endpoint için request body doğrulama kuralları
// ─────────────────────────────────────────────────────

import { Request, Response, NextFunction } from 'express';

// ── Validation Rule Types ──
interface FieldRule {
  type: 'string' | 'number' | 'boolean' | 'email' | 'phone' | 'date';
  required?: boolean;
  min?: number;       // string: minLength, number: minValue
  max?: number;       // string: maxLength, number: maxValue
  enum?: string[];    // sadece bu değerler kabul edilir
  pattern?: RegExp;   // regex eşleştirme
  message?: string;   // özel hata mesajı
}

type ValidationSchema = Record<string, FieldRule>;

// ── Validation Error ──
interface ValidationError {
  field: string;
  message: string;
}

// ── Ana doğrulama fonksiyonu ──
function validateBody(body: any, schema: ValidationSchema): ValidationError[] {
  const errors: ValidationError[] = [];

  for (const [field, rule] of Object.entries(schema)) {
    const value = body[field];

    // Required kontrolü
    if (rule.required && (value === undefined || value === null || value === '')) {
      errors.push({
        field,
        message: rule.message || `${field} zorunludur`,
      });
      continue;
    }

    // Değer yoksa ve required değilse, atla
    if (value === undefined || value === null) continue;

    // Type kontrolü
    switch (rule.type) {
      case 'string':
        if (typeof value !== 'string') {
          errors.push({ field, message: `${field} metin olmalıdır` });
          continue;
        }
        if (rule.min && value.length < rule.min) {
          errors.push({ field, message: `${field} en az ${rule.min} karakter olmalıdır` });
        }
        if (rule.max && value.length > rule.max) {
          errors.push({ field, message: `${field} en fazla ${rule.max} karakter olmalıdır` });
        }
        if (rule.pattern && !rule.pattern.test(value)) {
          errors.push({ field, message: rule.message || `${field} geçersiz formatta` });
        }
        if (rule.enum && !rule.enum.includes(value)) {
          errors.push({ field, message: `${field} şunlardan biri olmalıdır: ${rule.enum.join(', ')}` });
        }
        break;

      case 'number':
        const num = typeof value === 'string' ? parseFloat(value) : value;
        if (typeof num !== 'number' || isNaN(num)) {
          errors.push({ field, message: `${field} sayı olmalıdır` });
          continue;
        }
        if (rule.min !== undefined && num < rule.min) {
          errors.push({ field, message: `${field} en az ${rule.min} olmalıdır` });
        }
        if (rule.max !== undefined && num > rule.max) {
          errors.push({ field, message: `${field} en fazla ${rule.max} olmalıdır` });
        }
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          errors.push({ field, message: `${field} true/false olmalıdır` });
        }
        break;

      case 'email':
        if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          errors.push({ field, message: 'Geçersiz e-posta formatı' });
        }
        break;

      case 'phone':
        if (typeof value !== 'string' || !/^\+?[0-9]{10,15}$/.test(value.replace(/[\s()-]/g, ''))) {
          errors.push({ field, message: 'Geçersiz telefon numarası formatı' });
        }
        break;

      case 'date':
        const d = new Date(value);
        if (isNaN(d.getTime())) {
          errors.push({ field, message: `${field} geçersiz tarih` });
        }
        break;
    }
  }

  return errors;
}

// ── Middleware Factory ──
export function validate(schema: ValidationSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    const errors = validateBody(req.body, schema);
    if (errors.length > 0) {
      return res.status(400).json({
        error: 'Doğrulama hatası',
        details: errors,
      });
    }
    next();
  };
}

// ══════════════════════════════════════════════════════
// PRESET SCHEMAS — Endpoint'lere özel doğrulama kuralları
// ══════════════════════════════════════════════════════

// Auth: Register
export const registerSchema: ValidationSchema = {
  phone: { type: 'phone', required: true, message: 'Geçerli bir telefon numarası girin' },
  name: { type: 'string', required: true, min: 2, max: 100, message: 'Ad 2 ile 100 karakter arasında olmalıdır' },
  email: { type: 'email', required: false },
  password: { type: 'string', required: false, min: 6, max: 100, message: 'Şifre en az 6 karakter olmalıdır' },
  gender: { type: 'string', required: false, enum: ['male', 'female', 'other'] },
};

// Auth: Login
export const loginSchema: ValidationSchema = {
  phone: { type: 'phone', required: true, message: 'Telefon numarasını girin' },
};

// Gift Card: Purchase
export const purchaseGiftCardSchema: ValidationSchema = {
  amount: { type: 'number', required: false, min: 10, max: 10000, message: 'Tutar ₺10 ile ₺10.000 arasında olmalıdır' },
  templateId: { type: 'string', required: false },
  recipientPhone: { type: 'phone', required: false },
  message: { type: 'string', required: false, max: 500 },
};

// Token: QR Pay Generate
export const tokenQrPaySchema: ValidationSchema = {
  amount: { type: 'number', required: true, min: 1, max: 1000000, message: '1 ile 1.000.000 jeton arasında olmalıdır' },
  merchantId: { type: 'string', required: true, message: 'merchantId zorunludur' },
};

// Token: QR Pay Confirm
export const tokenQrConfirmSchema: ValidationSchema = {
  qrPayload: { type: 'string', required: true, message: 'QR kod zorunludur' },
};

// Redeem: Scan
export const redeemScanSchema: ValidationSchema = {
  code: { type: 'string', required: true, min: 5, message: 'Sertifika kodu zorunludur' },
};

// Redeem: Confirm
export const redeemConfirmSchema: ValidationSchema = {
  cardId: { type: 'string', required: true },
  branchId: { type: 'string', required: true },
};

// Token: Convert Card
export const convertCardSchema: ValidationSchema = {
  giftCardId: { type: 'string', required: true, message: 'giftCardId zorunludur' },
};

// Merchant: Register
export const merchantRegisterSchema: ValidationSchema = {
  name: { type: 'string', required: true, min: 2, max: 200 },
  category: { type: 'string', required: true, enum: ['restaurant', 'spa', 'clinic', 'electronics', 'mall', 'sport', 'clothing', 'events', 'tourism', 'other'] },
  contactPhone: { type: 'phone', required: true },
  ownerName: { type: 'string', required: true, min: 2 },
  ownerPassword: { type: 'string', required: true, min: 6 },
  bankAccount: { type: 'string', required: true, min: 5 },
  bankName: { type: 'string', required: true },
  binIin: { type: 'string', required: true, min: 10, max: 12, message: 'Vergi No 10-12 karakter olmalıdır' },
};

// Commission Update
export const commissionSchema: ValidationSchema = {
  commissionRate: { type: 'number', required: true, min: 0, max: 0.5, message: 'Komisyon %0 ile %50 arasında olmalıdır' },
};

// Notification: Send
export const notificationSendSchema: ValidationSchema = {
  userId: { type: 'string', required: true },
  title: { type: 'string', required: true, min: 1, max: 200 },
  body: { type: 'string', required: true, min: 1, max: 1000 },
  type: { type: 'string', required: false, enum: ['cert_convert_reminder', 'new_partner', 'promo', 'special_day', 'gift_suggestion', 'token_earned', 'referral', 'task_available', 'system'] },
};

// Notification: Broadcast
export const notificationBroadcastSchema: ValidationSchema = {
  title: { type: 'string', required: true, min: 1, max: 200 },
  body: { type: 'string', required: true, min: 1, max: 1000 },
};

// Connection: Request
export const connectionRequestSchema: ValidationSchema = {
  phone: { type: 'phone', required: true, message: 'Arkadaşın telefon numarasını girin' },
  nickname: { type: 'string', required: false, max: 50 },
};

// Mystery Task: Complete
export const mysteryTaskCompleteSchema: ValidationSchema = {
  taskId: { type: 'string', required: true },
  rating: { type: 'number', required: false, min: 1, max: 5 },
  comment: { type: 'string', required: false, max: 2000 },
};

// Profile Update
export const profileUpdateSchema: ValidationSchema = {
  name: { type: 'string', required: false, min: 2, max: 100 },
  email: { type: 'email', required: false },
  gender: { type: 'string', required: false, enum: ['male', 'female', 'other'] },
};

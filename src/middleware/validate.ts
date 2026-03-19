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
        message: rule.message || `${field} обязательно`,
      });
      continue;
    }

    // Değer yoksa ve required değilse, atla
    if (value === undefined || value === null) continue;

    // Type kontrolü
    switch (rule.type) {
      case 'string':
        if (typeof value !== 'string') {
          errors.push({ field, message: `${field} должен быть строкой` });
          continue;
        }
        if (rule.min && value.length < rule.min) {
          errors.push({ field, message: `${field} минимум ${rule.min} символов` });
        }
        if (rule.max && value.length > rule.max) {
          errors.push({ field, message: `${field} максимум ${rule.max} символов` });
        }
        if (rule.pattern && !rule.pattern.test(value)) {
          errors.push({ field, message: rule.message || `${field} имеет неверный формат` });
        }
        if (rule.enum && !rule.enum.includes(value)) {
          errors.push({ field, message: `${field} должен быть одним из: ${rule.enum.join(', ')}` });
        }
        break;

      case 'number':
        const num = typeof value === 'string' ? parseFloat(value) : value;
        if (typeof num !== 'number' || isNaN(num)) {
          errors.push({ field, message: `${field} должен быть числом` });
          continue;
        }
        if (rule.min !== undefined && num < rule.min) {
          errors.push({ field, message: `${field} минимум ${rule.min}` });
        }
        if (rule.max !== undefined && num > rule.max) {
          errors.push({ field, message: `${field} максимум ${rule.max}` });
        }
        break;

      case 'boolean':
        if (typeof value !== 'boolean') {
          errors.push({ field, message: `${field} должен быть true/false` });
        }
        break;

      case 'email':
        if (typeof value !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          errors.push({ field, message: 'Неверный формат email' });
        }
        break;

      case 'phone':
        if (typeof value !== 'string' || !/^\+?[0-9]{10,15}$/.test(value.replace(/[\s()-]/g, ''))) {
          errors.push({ field, message: 'Неверный формат телефона' });
        }
        break;

      case 'date':
        const d = new Date(value);
        if (isNaN(d.getTime())) {
          errors.push({ field, message: `${field} — неверная дата` });
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
        error: 'Ошибка валидации',
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
  phone: { type: 'phone', required: true, message: 'Укажите корректный номер телефона' },
  name: { type: 'string', required: true, min: 2, max: 100, message: 'Имя от 2 до 100 символов' },
  email: { type: 'email', required: false },
  password: { type: 'string', required: false, min: 6, max: 100, message: 'Пароль минимум 6 символов' },
  gender: { type: 'string', required: false, enum: ['male', 'female', 'other'] },
};

// Auth: Login
export const loginSchema: ValidationSchema = {
  phone: { type: 'phone', required: true, message: 'Укажите номер телефона' },
};

// Gift Card: Purchase
export const purchaseGiftCardSchema: ValidationSchema = {
  amount: { type: 'number', required: false, min: 1000, max: 500000, message: 'Сумма от ₸1,000 до ₸500,000' },
  templateId: { type: 'string', required: false },
  recipientPhone: { type: 'phone', required: false },
  message: { type: 'string', required: false, max: 500 },
};

// Token: QR Pay Generate
export const tokenQrPaySchema: ValidationSchema = {
  amount: { type: 'number', required: true, min: 1, max: 1000000, message: 'Сумма от 1 до 1,000,000 токенов' },
  merchantId: { type: 'string', required: true, message: 'merchantId обязателен' },
};

// Token: QR Pay Confirm
export const tokenQrConfirmSchema: ValidationSchema = {
  qrPayload: { type: 'string', required: true, message: 'QR-код обязателен' },
};

// Redeem: Scan
export const redeemScanSchema: ValidationSchema = {
  code: { type: 'string', required: true, min: 5, message: 'Код сертификата обязателен' },
};

// Redeem: Confirm
export const redeemConfirmSchema: ValidationSchema = {
  cardId: { type: 'string', required: true },
  branchId: { type: 'string', required: true },
};

// Token: Convert Card
export const convertCardSchema: ValidationSchema = {
  giftCardId: { type: 'string', required: true, message: 'giftCardId обязателен' },
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
  binIin: { type: 'string', required: true, min: 10, max: 12, message: 'БИН/ИИН должен быть 10-12 символов' },
};

// Commission Update
export const commissionSchema: ValidationSchema = {
  commissionRate: { type: 'number', required: true, min: 0, max: 0.5, message: 'Комиссия от 0% до 50%' },
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
  phone: { type: 'phone', required: true, message: 'Укажите номер телефона друга' },
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

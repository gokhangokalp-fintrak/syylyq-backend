import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../lib/prisma';
import { generateToken, requireAuth, checkLoginAttempt, recordLoginFailure, recordLoginSuccess } from '../middleware/auth';
import { validate, registerSchema, loginSchema, merchantRegisterSchema, profileUpdateSchema } from '../middleware/validate';
import { v4 as uuid } from 'uuid';

export const authRoutes = Router();

// ── User Registration ──
authRoutes.post('/register', validate(registerSchema), async (req, res) => {
  try {
    const { phone, name, email, password, referralCode: inviteCode, birthday, gender } = req.body;

    if (!phone || !name) {
      return res.status(400).json({ error: 'Telefon ve ad gerekli' });
    }

    const existing = await prisma.user.findUnique({ where: { phone } });
    if (existing) {
      return res.status(400).json({ error: 'Bu kullanıcı zaten kayıtlı' });
    }

    // Generate unique referral code
    const referralCode = name.toUpperCase().slice(0, 5) + Math.random().toString(36).slice(2, 6).toUpperCase();

    // Hash password if provided
    const hashedPw = password ? await bcrypt.hash(password, 10) : null;

    // Generate unique VITA ID (subscriber number)
    const userCount = await prisma.user.count();
    const vitaId = `VITA-${(100001 + userCount).toString()}`;

    const user = await prisma.user.create({
      data: {
        phone,
        name,
        email,
        password: hashedPw,
        referralCode,
        vitaId,
        referredBy: inviteCode || null,
        ...(birthday !== undefined && { birthday: birthday ? new Date(birthday) : null }) as any,
        ...(gender !== undefined && { gender: gender || null }) as any,
      },
    });

    // Handle referral reward
    if (inviteCode) {
      const referrer = await prisma.user.findUnique({ where: { referralCode: inviteCode } });
      if (referrer) {
        await prisma.referral.create({
          data: {
            referrerId: referrer.id,
            referredId: user.id,
            status: 'downloaded',
            activatedAt: new Date(),
          },
        });

        // Award tokens to referrer
        const rewardAmount = 50;
        await prisma.user.update({
          where: { id: referrer.id },
          data: { tokenBalance: { increment: rewardAmount } },
        });
        await prisma.tokenTransaction.create({
          data: {
            userId: referrer.id,
            amount: rewardAmount,
            type: 'earn_referral',
            source: `Davet: ${user.name}`,
            isCashable: false,
            balanceAfter: referrer.tokenBalance + rewardAmount,
            relatedId: user.id,
          },
        });
      }
    }

    const token = generateToken({ id: user.id, role: user.role, type: 'user' });
    res.json({ user: { id: user.id, name: user.name, phone: user.phone, referralCode: user.referralCode, tokenBalance: user.tokenBalance, email: user.email, avatarUrl: user.avatarUrl, role: user.role, vitaId: user.vitaId, cityId: user.cityId }, token });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Kayıt hatası' });
  }
});

// ── User Login (phone + password, or phone-only for MVP) ──
authRoutes.post('/login', validate(loginSchema), async (req, res) => {
  try {
    const { phone, password } = req.body;

    // Brute-force koruması
    const attempt = checkLoginAttempt(`user:${phone}`);
    if (!attempt.allowed) {
      return res.status(429).json({
        error: `Çok fazla deneme. ${attempt.retryAfterSec} saniye sonra tekrar deneyin.`,
        retryAfterSec: attempt.retryAfterSec,
      });
    }

    const user = await prisma.user.findUnique({ where: { phone } });
    if (!user) {
      recordLoginFailure(`user:${phone}`);
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }

    // If user has a password set, verify it
    if (user.password && password) {
      const valid = await bcrypt.compare(password, user.password);
      if (!valid) {
        recordLoginFailure(`user:${phone}`);
        return res.status(401).json({ error: 'Yanlış şifre' });
      }
    }
    // If no password in DB (legacy/MVP users), allow login with phone only

    recordLoginSuccess(`user:${phone}`);
    const token = generateToken({ id: user.id, role: user.role, type: 'user' });
    res.json({ user: { id: user.id, name: user.name, phone: user.phone, referralCode: user.referralCode, tokenBalance: user.tokenBalance, email: user.email, avatarUrl: user.avatarUrl, role: user.role, vitaId: user.vitaId, cityId: user.cityId }, token });
  } catch (err) {
    res.status(500).json({ error: 'Giriş hatası' });
  }
});

// ── Merchant Login ──
authRoutes.post('/merchant/login', validate(loginSchema), async (req, res) => {
  try {
    const { phone, password } = req.body;

    // Brute-force koruması
    const attempt = checkLoginAttempt(`merchant:${phone}`);
    if (!attempt.allowed) {
      return res.status(429).json({
        error: `Çok fazla deneme. ${attempt.retryAfterSec} saniye sonra tekrar deneyin.`,
        retryAfterSec: attempt.retryAfterSec,
      });
    }

    const merchantUser = await prisma.merchantUser.findUnique({
      where: { phone },
      include: { merchant: true },
    });

    if (!merchantUser) {
      recordLoginFailure(`merchant:${phone}`);
      return res.status(404).json({ error: 'İş ortağı bulunamadı' });
    }

    const valid = await bcrypt.compare(password, merchantUser.password);
    if (!valid) {
      recordLoginFailure(`merchant:${phone}`);
      return res.status(401).json({ error: 'Yanlış şifre' });
    }

    recordLoginSuccess(`merchant:${phone}`);
    const token = generateToken({
      id: merchantUser.id,
      role: merchantUser.role,
      type: 'merchant',
      merchantId: merchantUser.merchantId,
    });

    res.json({
      user: { id: merchantUser.id, name: merchantUser.name, role: merchantUser.role },
      merchant: { id: merchantUser.merchant.id, name: merchantUser.merchant.name },
      token,
    });
  } catch (err) {
    res.status(500).json({ error: 'Giriş hatası' });
  }
});

// ── Get current user profile ──
authRoutes.get('/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.id },
      select: {
        id: true, name: true, phone: true, email: true, avatarUrl: true,
        tokenBalance: true, referralCode: true, cityId: true, streakDays: true,
        createdAt: true,
        _count: { select: { purchasedCards: true, receivedCards: true, referralsSent: true } },
      } as any, // birthday and gender fields not yet in generated Prisma client
    });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Hata' });
  }
});

// ── Update user profile ──
authRoutes.put('/me', requireAuth, validate(profileUpdateSchema), async (req, res) => {
  try {
    const { name, email, avatarUrl, cityId, birthday, gender } = req.body;
    const user = await prisma.user.update({
      where: { id: req.auth!.id },
      data: {
        ...(name && { name }),
        ...(email !== undefined && { email }),
        ...(avatarUrl !== undefined && { avatarUrl }),
        ...(cityId !== undefined && { cityId }),
        ...(birthday !== undefined && { birthday: birthday ? new Date(birthday) : null }),
        ...(gender !== undefined && { gender }),
      },
      select: {
        id: true, name: true, phone: true, email: true, avatarUrl: true,
        tokenBalance: true, referralCode: true, cityId: true, createdAt: true,
      },
    });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Profil güncelleme hatası' });
  }
});

// ── User Settings (JSON) ──
authRoutes.get('/settings', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.id },
      select: { settings: true } as any,
    });

    const defaults = {
      language: 'ru',
      currency: 'KZT',
      pushNotifications: true,
      dailyReminder: true,
      friendActivity: true,
      soundEffects: true,
      haptics: true,
      biometricLogin: false,
    };

    let settings = defaults;
    try {
      if ((user as any)?.settings) {
        settings = { ...defaults, ...JSON.parse((user as any).settings) };
      }
    } catch {}

    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: 'Hata' });
  }
});

authRoutes.put('/settings', requireAuth, async (req, res) => {
  try {
    const allowedKeys = [
      'language', 'currency', 'pushNotifications', 'dailyReminder',
      'friendActivity', 'soundEffects', 'haptics', 'biometricLogin',
    ];

    // Mevcut ayarları al
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.id },
      select: { settings: true } as any,
    });

    let current: any = {};
    try {
      if ((user as any)?.settings) {
        current = JSON.parse((user as any).settings);
      }
    } catch {}

    // Sadece izin verilen key'leri güncelle
    for (const key of allowedKeys) {
      if (req.body[key] !== undefined) {
        current[key] = req.body[key];
      }
    }

    await (prisma as any).user.update({
      where: { id: req.auth!.id },
      data: { settings: JSON.stringify(current) },
    });

    res.json({ success: true, settings: current });
  } catch (err) {
    console.error('[Settings] Update error:', err);
    res.status(500).json({ error: 'Hata' });
  }
});

// ── Merchant Self-Registration ──
// İşletme kaydı: banka bilgileri zorunlu (batch settlement için)
authRoutes.post('/merchant/register', validate(merchantRegisterSchema), async (req, res) => {
  try {
    const { name, category, contactPhone, contactEmail, binIin, bankAccount, bankName, settlementMethod, ownerName, ownerPassword } = req.body;

    if (!name || !category || !contactPhone || !ownerName || !ownerPassword) {
      return res.status(400).json({ error: 'Tüm zorunlu alanlar doldurulmalıdır' });
    }

    // Banka bilgileri zorunlu — batch settlement için
    if (!bankAccount || !bankName) {
      return res.status(400).json({
        error: 'Banka bilgileri ödeme için gereklidir',
        details: 'IBAN numarası ve banka adı girin',
      });
    }

    if (!binIin) {
      return res.status(400).json({
        error: 'Vergi numarası ödeme için gereklidir',
      });
    }

    // Check if merchant phone already registered
    const existingMerchantUser = await prisma.merchantUser.findUnique({ where: { phone: contactPhone } });
    if (existingMerchantUser) {
      return res.status(400).json({ error: 'Bu numara zaten kayıtlı' });
    }

    // Create merchant (pending approval)
    const merchant = await prisma.merchant.create({
      data: {
        name,
        category,
        contactPhone,
        contactEmail,
        binIin,
        bankAccount,
        bankName,
        settlementMethod: settlementMethod || 'kaspi',
        approvalStatus: 'pending',
      },
    });

    // Create merchant owner user
    const hashedPassword = await bcrypt.hash(ownerPassword, 10);
    const merchantUser = await prisma.merchantUser.create({
      data: {
        merchantId: merchant.id,
        phone: contactPhone,
        name: ownerName,
        role: 'owner',
        password: hashedPassword,
      },
    });

    const token = generateToken({
      id: merchantUser.id,
      role: 'owner',
      type: 'merchant',
      merchantId: merchant.id,
    });

    res.json({
      message: 'Başvurunuz incelemeye alındı',
      merchant: { id: merchant.id, name: merchant.name, approvalStatus: 'pending' },
      user: { id: merchantUser.id, name: merchantUser.name },
      token,
    });
  } catch (err) {
    console.error('Merchant register error:', err);
    res.status(500).json({ error: 'İş ortağı kayıt hatası' });
  }
});

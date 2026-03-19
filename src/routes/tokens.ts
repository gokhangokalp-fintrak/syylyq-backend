import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMerchant } from '../middleware/auth';
import { validate, tokenQrPaySchema, tokenQrConfirmSchema, convertCardSchema } from '../middleware/validate';
import crypto from 'crypto';

export const tokenRoutes = Router();

// ── QR Nonce Replay Protection ──
// Kullanılmış nonce'ları tutar — aynı QR iki kez taranamaz
// Memory-based (restart'ta sıfırlanır) + 10 dakika TTL
const usedNonces = new Map<string, number>(); // nonce → timestamp
const NONCE_TTL = 10 * 60 * 1000; // 10 dakika

// Periyodik temizlik (her 5 dakikada eski nonce'ları sil)
setInterval(() => {
  const now = Date.now();
  for (const [nonce, ts] of usedNonces) {
    if (now - ts > NONCE_TTL) usedNonces.delete(nonce);
  }
}, 5 * 60 * 1000);

// ── Token balance & history ──
tokenRoutes.get('/balance', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.auth!.id } });
    if (!user) return res.status(404).json({ error: 'Bulunamadı' });

    const transactions = await prisma.tokenTransaction.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({
      balance: user.tokenBalance,
      // Yeni modelde tüm tokenlar loyalty point — cashable ayrımı yok
      cashableBalance: 0,
      nonCashableBalance: user.tokenBalance,
      history: transactions,
    });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Token history (separate endpoint) ──
tokenRoutes.get('/history', requireAuth, async (req, res) => {
  try {
    const { limit = '50', type } = req.query;
    const where: any = { userId: req.auth!.id };
    if (type) where.type = type;

    const transactions = await prisma.tokenTransaction.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });
    res.json(transactions);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ══════════════════════════════════════════════════════
// DISABLED: Transfer tokens (lisans gerektirir)
// ══════════════════════════════════════════════════════
tokenRoutes.post('/transfer', requireAuth, async (_req, res) => {
  res.status(403).json({
    error: 'Token aktarım işlevi geçici olarak kullanılamaz',
    message: 'VITA ortakları arasında ödeme için token kullanın',
    comingSoon: true,
  });
});

// ══════════════════════════════════════════════════════
// DISABLED: Cash out tokens (lisans gerektirir)
// ══════════════════════════════════════════════════════
tokenRoutes.post('/cashout', requireAuth, async (_req, res) => {
  res.status(403).json({
    error: 'Token çekme işlevi geçici olarak kullanılamaz',
    message: 'VITA ortakları arasında ödeme için token kullanın',
    comingSoon: true,
  });
});

// ══════════════════════════════════════════════════════
// NEW: Earn tokens from activities (games, daily bonus, etc.)
// Anti-fraud: günde max 50 token, her activity tipi için ayrı limit
// ══════════════════════════════════════════════════════
tokenRoutes.post('/earn-activity', requireAuth, async (req, res) => {
  try {
    const { amount, source, activityType } = req.body;
    const userId = req.auth!.id;

    if (!amount || amount <= 0 || amount > 50) {
      return res.status(400).json({ error: 'Geçersiz tutar (1-50 token)' });
    }

    if (!source || !activityType) {
      return res.status(400).json({ error: 'Kaynak ve etkinlik türünü belirtin' });
    }

    // Günlük limit kontrol — her activity type'ı ayrı
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEarned = await prisma.tokenTransaction.aggregate({
      where: {
        userId,
        type: 'earn_activity',
        source: { contains: activityType },
        createdAt: { gte: today },
      },
      _sum: { amount: true },
    });

    const dailyEarned = todayEarned._sum.amount || 0;
    const DAILY_LIMIT = 50; // günlük toplam oyun token limiti

    if (dailyEarned + amount > DAILY_LIMIT) {
      return res.status(400).json({
        error: 'Aktiviteler için günlük token sınırı tükendi',
        dailyEarned,
        dailyLimit: DAILY_LIMIT,
      });
    }

    // Kullanıcı bakiyesini güncelle
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

    await prisma.user.update({
      where: { id: userId },
      data: { tokenBalance: { increment: amount } },
    });

    // Token transaction kaydı
    await prisma.tokenTransaction.create({
      data: {
        userId,
        amount,
        type: 'earn_activity',
        source: `${source} [${activityType}]`,
        isCashable: false,
        balanceAfter: user.tokenBalance + amount,
      },
    });

    console.log(`🎮 Activity tokens: +${amount} for ${user.name} (${activityType})`);

    res.json({
      success: true,
      tokensAdded: amount,
      newBalance: user.tokenBalance + amount,
      dailyEarned: dailyEarned + amount,
      dailyLimit: DAILY_LIMIT,
    });
  } catch (err) {
    console.error('Earn activity error:', err);
    res.status(500).json({ error: 'Token tahsisatı sunucu hatası' });
  }
});

// ══════════════════════════════════════════════════════
// NEW: QR Token Payment (partnerde token harcama)
// Kullanıcı QR oluşturur → merchant tarar → token düşer
// VITA merchant'a komisyon sonrası borçlanır
// ══════════════════════════════════════════════════════

// Step 1: Kullanıcı ödeme QR kodu oluşturur
tokenRoutes.post('/qr-pay/create', requireAuth, validate(tokenQrPaySchema), async (req, res) => {
  try {
    const { amount } = req.body;
    const userId = req.auth!.id;

    if (!amount || amount < 100) {
      return res.status(400).json({ error: 'Minimum tutar: 100 token' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

    if (user.tokenBalance < amount) {
      return res.status(400).json({ error: 'Yetersiz token bakiyesi' });
    }

    // QR kodu oluştur — merchant bu kodu tarayacak
    const qrPayload = {
      type: 'token_pay',
      userId,
      amount,
      ts: Date.now(),
      nonce: crypto.randomBytes(8).toString('hex'),
    };

    const secret = process.env.QR_SECRET || 'syylyq-qr-2026';
    const sig = crypto.createHmac('sha256', secret)
      .update(JSON.stringify(qrPayload))
      .digest('hex')
      .slice(0, 16);

    const qrData = JSON.stringify({ ...qrPayload, sig });

    res.json({
      qrData,
      amount,
      balance: user.tokenBalance,
      expiresIn: 300, // 5 dakika geçerli
    });
  } catch (err) {
    console.error('QR pay create error:', err);
    res.status(500).json({ error: 'Oluşturma hatası QR' });
  }
});

// Step 2: Merchant QR'ı tarar ve ödemeyi onaylar
tokenRoutes.post('/qr-pay/confirm', requireAuth, requireMerchant, validate(tokenQrConfirmSchema), async (req, res) => {
  try {
    const { qrData, branchId } = req.body;
    const merchantId = req.auth!.merchantId as string;
    const verifiedBy = req.auth!.id;

    if (!qrData) {
      return res.status(400).json({ error: 'QR verileri yok' });
    }

    // QR parse et
    let parsed: any;
    try {
      parsed = JSON.parse(qrData);
    } catch {
      return res.status(400).json({ error: 'Geçersiz QR kodu' });
    }

    if (parsed.type !== 'token_pay') {
      return res.status(400).json({ error: 'Geçersiz QR kod türü' });
    }

    // İmza doğrula
    const secret = process.env.QR_SECRET || 'syylyq-qr-2026';
    const { sig, ...payload } = parsed;
    const expectedSig = crypto.createHmac('sha256', secret)
      .update(JSON.stringify(payload))
      .digest('hex')
      .slice(0, 16);

    if (sig !== expectedSig) {
      return res.status(400).json({ error: 'QR imzası geçersiz' });
    }

    // QR süresi kontrol (5 dakika)
    if (Date.now() - parsed.ts > 5 * 60 * 1000) {
      return res.status(400).json({ error: 'QR kod süresi doldu. Yeni kod isteyin.' });
    }

    // Nonce replay koruması — aynı QR iki kez taranamaz
    if (usedNonces.has(parsed.nonce)) {
      return res.status(400).json({ error: 'QR kod zaten kullanılmış. Yeni kod isteyin.' });
    }
    usedNonces.set(parsed.nonce, Date.now());

    const { userId, amount } = parsed;

    // Kullanıcıyı bul ve bakiye kontrol
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.tokenBalance < amount) {
      return res.status(400).json({ error: 'Kullanıcının yetersiz token bakiyesi' });
    }

    // Merchant'ı bul
    const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant || merchant.approvalStatus !== 'approved') {
      return res.status(400).json({ error: 'İş ortağı etkin değil' });
    }

    // Komisyon hesapla (merchant'ın gerçek komisyon oranı — schema'da varsayılan 0.07)
    const commissionRate = merchant.commissionRate;
    const commissionAmount = Math.round(amount * commissionRate);
    const netAmount = amount - commissionAmount;

    // ── Atomik işlem: token düş + kayıtları oluştur ──
    const result = await prisma.$transaction(async (tx) => {
      // Tekrar bakiye kontrol (race condition önleme)
      const freshUser = await tx.user.findUnique({ where: { id: userId } });
      if (!freshUser || freshUser.tokenBalance < amount) {
        throw new Error('INSUFFICIENT_BALANCE');
      }

      // Token düş
      await tx.user.update({
        where: { id: userId },
        data: { tokenBalance: { decrement: amount } },
      });

      // Token transaction kaydı
      await tx.tokenTransaction.create({
        data: {
          userId,
          amount: -amount,
          type: 'spend_purchase',
          source: `Token Ödemesi: ${merchant.name}`,
          isCashable: false,
          balanceAfter: freshUser.tokenBalance - amount,
        },
      });

      // TokenRedemption kaydı — VITA merchant'a borçlanır
      const redemption = await tx.tokenRedemption.create({
        data: {
          userId,
          merchantId,
          branchId: branchId || null,
          amount,
          commissionRate,
          commissionAmount,
          netAmount,
          status: 'completed',
          verifiedBy,
        },
      });

      // Settlement oluştur — batch ile toplanacak, ertesi gün ödenecek
      const settlement = await tx.settlement.create({
        data: {
          merchantId,
          totalAmount: amount,
          commissionAmount,
          netAmount,
          commissionRate,
          method: merchant.settlementMethod,
          status: 'pending', // akşam batch'e dahil edilecek
        },
      });

      return { redemption, settlement, newBalance: freshUser.tokenBalance - amount };
    });

    console.log(`🪙 Token QR Payment: -${amount} tokens from ${user.name} at ${merchant.name} (net: ${netAmount}₸, batch pending)`);

    res.json({
      success: true,
      redemption: {
        id: result.redemption.id,
        amount,
        commission: commissionAmount,
        netToMerchant: netAmount,
        merchantName: merchant.name,
      },
      userNewBalance: result.newBalance,
      settlementId: result.settlement.id,
    });
  } catch (err: any) {
    if (err.message === 'INSUFFICIENT_BALANCE') {
      return res.status(400).json({ error: 'Kullanıcının yetersiz token bakiyesi' });
    }
    console.error('QR pay confirm error:', err);
    res.status(500).json({ error: 'Ödeme işleme sunucu hatası' });
  }
});

// ══════════════════════════════════════════════════════
// NEW: Gift Card → Token Conversion (0% komisyon)
// Hediye çeki tokenlere çevrilir, parça parça kullanılır
// ══════════════════════════════════════════════════════
tokenRoutes.post('/convert-card', requireAuth, validate(convertCardSchema), async (req, res) => {
  try {
    const { giftCardId } = req.body;
    const userId = req.auth!.id;

    if (!giftCardId) {
      return res.status(400).json({ error: 'Sertifika ID zorunludur' });
    }

    // Çeki bul (conversion ve merchant include — prisma generate sonrası çalışır)
    const card: any = await prisma.giftCard.findUnique({
      where: { id: giftCardId },
      include: { merchant: true, conversion: true } as any,
    });

    if (!card) {
      return res.status(404).json({ error: 'Sertifika bulunamadı' });
    }

    // Sahibi kontrol (alıcı veya satın alan)
    if (card.buyerId !== userId && card.recipientId !== userId) {
      return res.status(403).json({ error: 'Bu sertifikaya erişim yok' });
    }

    // Durum kontrol
    if (card.status !== 'active' && card.status !== 'sent') {
      return res.status(400).json({ error: `Sertifika dönüştürülemez (durum: ${card.status})` });
    }

    // Daha önce dönüştürülmüş mü?
    if (card.conversion) {
      return res.status(400).json({ error: 'Sertifika zaten tokena dönüştürüldü' });
    }

    const tokenAmount = card.amount; // 1:1, 0% komisyon

    // ── Atomik işlem: bakiye güncelle + kart redeem + conversion + transaction ──
    const result = await prisma.$transaction(async (tx) => {
      // Tekrar kart durumu kontrol (race condition önleme)
      const freshCard: any = await tx.giftCard.findUnique({
        where: { id: giftCardId },
        include: { conversion: true } as any,
      });
      if (!freshCard || (freshCard.status !== 'active' && freshCard.status !== 'sent')) {
        throw new Error('CARD_NOT_AVAILABLE');
      }
      if (freshCard.conversion) {
        throw new Error('ALREADY_CONVERTED');
      }

      const user = await tx.user.findUnique({ where: { id: userId } });
      if (!user) throw new Error('USER_NOT_FOUND');

      // Kullanıcı bakiyesini güncelle
      await tx.user.update({
        where: { id: userId },
        data: { tokenBalance: { increment: tokenAmount } },
      });

      // Çeki "converted" olarak işaretle
      await tx.giftCard.update({
        where: { id: giftCardId },
        data: { status: 'redeemed' },
      });

      // Conversion kaydı
      await tx.giftCardConversion.create({
        data: {
          userId,
          giftCardId,
          amount: tokenAmount,
        },
      });

      // Token transaction kaydı
      await tx.tokenTransaction.create({
        data: {
          userId,
          amount: tokenAmount,
          type: 'earn_cashback',
          source: `Sertifika → token dönüştürme${card.merchant ? ` (${card.merchant.name})` : ''}`,
          isCashable: false,
          balanceAfter: user.tokenBalance + tokenAmount,
          relatedId: giftCardId,
        },
      });

      return { newBalance: user.tokenBalance + tokenAmount, userName: user.name };
    });

    console.log(`🔄 Card→Token: +${tokenAmount} tokens for ${result.userName} (card: ${card.code})`);

    res.json({
      success: true,
      tokensAdded: tokenAmount,
      newBalance: result.newBalance,
      cardCode: card.code,
      merchantName: card.merchant?.name || 'VITA Sertifika',
    });
  } catch (err: any) {
    if (err.message === 'CARD_NOT_AVAILABLE') {
      return res.status(400).json({ error: 'Sertifika dönüştürme için kullanılamaz' });
    }
    if (err.message === 'ALREADY_CONVERTED') {
      return res.status(400).json({ error: 'Sertifika zaten tokena dönüştürüldü' });
    }
    if (err.message === 'USER_NOT_FOUND') {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }
    console.error('Card conversion error:', err);
    res.status(500).json({ error: 'Dönüştürme sunucu hatası' });
  }
});

// ── Token redemption history (QR payments) ──
tokenRoutes.get('/redemptions', requireAuth, async (req, res) => {
  try {
    const redemptions = await prisma.tokenRedemption.findMany({
      where: { userId: req.auth!.id },
      include: {
        merchant: { select: { name: true, logoUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });
    res.json(redemptions);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { validate, purchaseGiftCardSchema } from '../middleware/validate';
import { v4 as uuid } from 'uuid';
import crypto from 'crypto';

export const giftCardRoutes = Router();

function generateCardCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const parts = Array.from({ length: 3 }, () =>
    Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  );
  return `SYY-${parts.join('-')}`;
}

function generateQRPayload(cardId: string, code: string): string {
  const secret = process.env.QR_SECRET || 'syylyq-qr-2026';
  const signature = crypto.createHmac('sha256', secret).update(cardId + code).digest('hex').slice(0, 12);
  return JSON.stringify({ id: cardId, code, sig: signature });
}

// ── Purchase gift card via PSP (real money — Kaspi Pay / Wooppay) ──
// Yeni model: VITA evrensel hediye çeki, gerçek para ile satın alınır
// Para direkt VITA'ya geçer, kullanıcı herhangi bir partnerde kullanır
giftCardRoutes.post('/purchase', requireAuth, validate(purchaseGiftCardSchema), async (req, res) => {
  try {
    const { templateId, amount: directAmount, recipientPhone, message, cityId, pspPaymentId } = req.body;
    const buyerId = req.auth!.id;

    const buyer = await prisma.user.findUnique({ where: { id: buyerId } });
    if (!buyer) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

    // PSP ödeme doğrulama (MVP'de mock, production'da Wooppay/Kaspi API)
    if (!pspPaymentId) {
      return res.status(400).json({ error: 'Kaspi Pay üzerinden ödeme gerekli' });
    }
    // TODO: PSP API'den ödeme onayını doğrula
    // const pspResult = await wooppayApi.verifyPayment(pspPaymentId);
    // if (!pspResult.success) return res.status(400).json({ error: 'Ödeme onaylanmadı' });

    let cardAmount: number;
    let validDays = 365;
    let cardTemplateId: string | null = null;
    let cardMerchantId: string | null = null;
    let merchantName = 'VITA Sertifika';

    if (templateId) {
      // ── Template-based purchase (belirli bir merchant şablonundan) ──
      const template = await prisma.cardTemplate.findUnique({
        where: { id: templateId },
        include: { merchant: true },
      });

      if (!template || !template.isActive) {
        return res.status(404).json({ error: 'Şablon bulunamadı' });
      }
      if (template.merchant.approvalStatus !== 'approved') {
        return res.status(400).json({ error: 'İş ortağı etkin değil' });
      }

      cardAmount = template.denomination;
      validDays = template.validDays;
      cardTemplateId = template.id;
      cardMerchantId = template.merchantId;
      merchantName = template.merchant.name;
    } else if (directAmount) {
      // ── VITA Universal Certificate (evrensel hediye çeki — template yok) ──
      cardAmount = directAmount;
      if (cardAmount < 1000 || cardAmount > 500000) {
        return res.status(400).json({ error: 'Tutar 1.000 ile 500.000₸ arasında olmalıdır' });
      }
    } else {
      return res.status(400).json({ error: 'TemplateId veya tutarı belirtin' });
    }

    const code = generateCardCode();
    const cardId = uuid();
    const qrData = generateQRPayload(cardId, code);

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + validDays);

    // Alıcıyı bul (varsa)
    let recipientId: string | null = null;
    if (recipientPhone) {
      const recipient = await prisma.user.findUnique({ where: { phone: recipientPhone } });
      if (recipient) recipientId = recipient.id;
    }

    const giftCard = await prisma.giftCard.create({
      data: {
        id: cardId,
        code,
        qrData,
        templateId: cardTemplateId,
        merchantId: cardMerchantId,
        buyerId,
        recipientId,
        recipientPhone: recipientPhone || null,
        cityId: cityId || null,
        amount: cardAmount,
        paidAmount: cardAmount,
        paidWithTokens: 0,
        isVitaCert: !cardTemplateId, // template yoksa evrensel VITA çeki
        status: recipientId || recipientPhone ? 'sent' : 'active',
        message: message || null,
        sentAt: recipientPhone ? new Date() : null,
        expiresAt,
      },
    });

    // Cashback token (hediye çeki alımında %3 token kazan)
    const cashbackTokens = Math.floor(cardAmount * 0.03);
    if (cashbackTokens > 0) {
      await prisma.user.update({
        where: { id: buyerId },
        data: { tokenBalance: { increment: cashbackTokens } },
      });
      await prisma.tokenTransaction.create({
        data: {
          userId: buyerId,
          amount: cashbackTokens,
          type: 'earn_cashback',
          source: `Sertifika satın alımı için geri ödeme: ${merchantName}`,
          isCashable: false,
          balanceAfter: buyer.tokenBalance + cashbackTokens,
          relatedId: cardId,
        },
      });
    }

    console.log(`🎫 Gift card purchased: ${code} — ${cardAmount}₸ (${!cardTemplateId ? 'VITA Universal' : merchantName})`);

    res.json({
      giftCard: {
        id: giftCard.id,
        code: giftCard.code,
        amount: giftCard.amount,
        merchantName,
        expiresAt: giftCard.expiresAt,
        status: giftCard.status,
        isVitaCert: !cardTemplateId,
        pspPaymentId,
      },
      cashbackTokens,
    });
  } catch (err) {
    console.error('Purchase error:', err);
    res.status(500).json({ error: 'Satın alma hatası' });
  }
});

// ── List user's gift cards ──
giftCardRoutes.get('/my', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { type } = req.query; // purchased | received

    const where: any = {};
    if (type === 'received') {
      where.recipientId = userId;
    } else if (type === 'purchased') {
      where.buyerId = userId;
    } else {
      where.OR = [{ buyerId: userId }, { recipientId: userId }];
    }

    const cards = await prisma.giftCard.findMany({
      where,
      include: {
        merchant: { select: { id: true, name: true, logoUrl: true, category: true } },
        template: { select: { name: true, bgColor: true, imageUrl: true } },
        buyer: { select: { id: true, name: true } },
        city: { select: { name: true } },
        redemption: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(cards);
  } catch (err) {
    res.status(500).json({ error: 'Kart yükleme hatası' });
  }
});

// ── Get single gift card detail ──
giftCardRoutes.get('/:id', requireAuth, async (req, res) => {
  try {
    const card = await prisma.giftCard.findUnique({
      where: { id: req.params.id },
      include: {
        merchant: true,
        template: true,
        city: true,
        buyer: { select: { name: true, phone: true } },
        recipient: { select: { name: true, phone: true } },
        redemption: { include: { branch: true } },
      },
    });

    if (!card) return res.status(404).json({ error: 'Kart bulunamadı' });

    // Only buyer or recipient can view
    if (card.buyerId !== req.auth!.id && card.recipientId !== req.auth!.id) {
      return res.status(403).json({ error: 'Erişim yok' });
    }

    res.json(card);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

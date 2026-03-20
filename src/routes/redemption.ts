import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMerchant } from '../middleware/auth';
import crypto from 'crypto';

export const redemptionRoutes = Router();

// ── Verify QR Code (merchant scans) ──
redemptionRoutes.post('/verify', requireAuth, requireMerchant, async (req, res) => {
  try {
    const { qrData } = req.body;
    const merchantId = req.auth!.merchantId;

    if (!qrData) {
      return res.status(400).json({ error: 'QR verileri yok' });
    }

    let parsed: { id: string; code: string; sig: string };
    try {
      parsed = JSON.parse(qrData);
    } catch {
      return res.status(400).json({ error: 'Geçersiz QR kodu', valid: false });
    }

    // Verify signature
    const secret = process.env.QR_SECRET || 'syylyq-qr-2026';
    const expectedSig = crypto.createHmac('sha256', secret)
      .update(parsed.id + parsed.code)
      .digest('hex').slice(0, 12);

    if (parsed.sig !== expectedSig) {
      return res.status(400).json({ error: 'QR imzası geçersiz', valid: false });
    }

    // Find the gift card
    const card = await prisma.giftCard.findUnique({
      where: { id: parsed.id },
      include: {
        merchant: true,
        template: true,
        recipient: { select: { name: true, phone: true } },
        buyer: { select: { name: true } },
      },
    });

    if (!card) {
      return res.status(404).json({ error: 'Sertifika bulunamadı', valid: false });
    }

    // VITA evrensel hediye çeki — herhangi bir partnerde kullanılabilir
    // merchantId kontrolü kaldırıldı (eski model: sadece o işletmede geçerliydi)

    if (card.status === 'redeemed') {
      return res.status(400).json({ error: 'Sertifika zaten kullanılmış', valid: false });
    }

    if (card.status === 'expired' || card.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Süresi doldu', valid: false });
    }

    if (card.status === 'refunded') {
      return res.status(400).json({ error: 'Sertifika iade edildi', valid: false });
    }

    // Return card info for confirmation
    res.json({
      valid: true,
      card: {
        id: card.id,
        code: card.code,
        amount: card.amount,
        merchantName: card.merchant?.name || 'VITA Sertifika',
        templateName: card.template?.name || 'VITA Sertifika',
        isVitaCert: card.isVitaCert || !card.merchantId,
        recipientName: card.recipient?.name || 'Belirtilmedi',
        buyerName: card.buyer.name,
        expiresAt: card.expiresAt,
      },
    });
  } catch (err) {
    console.error('Verify error:', err);
    res.status(500).json({ error: 'Doğrulama sunucu hatası', valid: false });
  }
});

// ── Confirm Redemption (merchant confirms after verification) ──
redemptionRoutes.post('/confirm', requireAuth, requireMerchant, async (req, res) => {
  try {
    const { giftCardId, branchId } = req.body;
    const merchantId = req.auth!.merchantId as string;
    const verifiedBy = req.auth!.id;

    if (!merchantId) {
      return res.status(400).json({ error: 'İş ortağı belirlenemedi' });
    }

    const card = await prisma.giftCard.findUnique({
      where: { id: giftCardId },
      include: { merchant: true },
    });

    if (!card) {
      return res.status(400).json({ error: 'Geçersiz sertifika' });
    }

    // VITA evrensel çek — herhangi bir partnerde kullanılabilir
    // Ödemeyi yapan merchant (scanning merchant) ile hesaplaşma yapılır
    const scanningMerchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
    if (!scanningMerchant || scanningMerchant.approvalStatus !== 'approved') {
      return res.status(400).json({ error: 'İş ortağı etkin değil' });
    }

    if (card.status !== 'active' && card.status !== 'sent') {
      return res.status(400).json({ error: `Sertifika kullanılamaz (durum: ${card.status})` });
    }

    // Verify branch belongs to merchant
    const branch = await prisma.branch.findFirst({
      where: { id: branchId, merchantId },
    });

    if (!branch) {
      return res.status(400).json({ error: 'Şube bulunamadı' });
    }

    // ── T+1 BATCH SETTLEMENT ──
    // VITA evrensel çek: komisyon scanning merchant'ın oranına göre
    // Ödeme akşam batch ile toplanır, ertesi gün yapılır
    const commissionRate = scanningMerchant.commissionRate;
    const totalAmount = card.amount;
    const commissionAmount = Math.round(totalAmount * commissionRate);
    const netAmount = totalAmount - commissionAmount;

    // ── Atomik işlem: settlement + redemption + kart güncelleme ──
    const result = await prisma.$transaction(async (tx) => {
      // Tekrar kart durumu kontrol (race condition önleme)
      const freshCard = await tx.giftCard.findUnique({ where: { id: card.id } });
      if (!freshCard || (freshCard.status !== 'active' && freshCard.status !== 'sent')) {
        throw new Error('CARD_NOT_AVAILABLE');
      }

      // Create settlement record — pending (batch ile toplanacak)
      const settlement = await tx.settlement.create({
        data: {
          merchantId, // scanning merchant (çekin kullanıldığı yer)
          totalAmount,
          commissionAmount,
          netAmount,
          commissionRate,
          method: scanningMerchant.settlementMethod,
          status: 'pending', // batch settlement bekliyor
        },
      });

      // Create redemption record
      const redemption = await tx.giftCardRedemption.create({
        data: {
          giftCardId: card.id,
          branchId,
          verifiedBy,
          amount: card.amount,
          settlementId: settlement.id,
        },
      });

      // Mark card as redeemed
      await tx.giftCard.update({
        where: { id: card.id },
        data: { status: 'redeemed' },
      });

      // ── Cari Hesap kaydı (LedgerEntry) ──
      const lastLedger = await (tx as any).ledgerEntry.findFirst({
        where: { merchantId },
        orderBy: { createdAt: 'desc' },
      });
      const prevBalance = lastLedger?.balance || 0;
      const newBalance = prevBalance + netAmount;

      await (tx as any).ledgerEntry.create({
        data: {
          merchantId,
          type: 'Sertifika Kullanım',
          description: `${card.code} — ${branch.name}`,
          debit: netAmount,
          credit: 0,
          balance: newBalance,
          relatedId: settlement.id,
        },
      });

      return { settlement, redemption };
    });

    console.log(`🎫 Gift card redeemed: ${card.code} at ${scanningMerchant.name} — ${netAmount}₺ net (batch pending)`);

    res.json({
      success: true,
      redemption: {
        id: result.redemption.id,
        amount: card.amount,
        branch: branch.name,
        redeemedAt: result.redemption.redeemedAt,
      },
      settlement: {
        id: result.settlement.id,
        grossAmount: totalAmount,
        commission: commissionAmount,
        commissionRate: `${(commissionRate * 100).toFixed(1)}%`,
        netAmount,
        status: 'pending',
        method: scanningMerchant.settlementMethod,
        note: 'Ödeme sonraki iş günü yapılacak',
      },
    });
  } catch (err: any) {
    if (err.message === 'CARD_NOT_AVAILABLE') {
      return res.status(400).json({ error: 'Sertifika zaten kullanılmış veya kullanılamaz' });
    }
    console.error('Redemption error:', err);
    res.status(500).json({ error: 'Sertifika kullanımı sunucu hatası' });
  }
});

// ── Verify by code (merchant panel — no JWT, uses code string) ──
redemptionRoutes.post('/verify-by-code', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Sertifika kodu zorunludur', valid: false });

    const card = await prisma.giftCard.findFirst({
      where: { code: code.trim().toUpperCase() },
      include: {
        merchant: true,
        template: true,
        recipient: { select: { name: true, phone: true } },
        buyer: { select: { name: true } },
      },
    });

    if (!card) return res.status(404).json({ error: 'Sertifika bulunamadı', valid: false });

    if (card.status === 'redeemed') return res.status(400).json({ error: 'Sertifika zaten kullanılmış', valid: false });
    if (card.status === 'expired' || card.expiresAt < new Date()) return res.status(400).json({ error: 'Süresi doldu', valid: false });
    if (card.status === 'refunded') return res.status(400).json({ error: 'Sertifika iade edildi', valid: false });

    res.json({
      valid: true,
      card: {
        id: card.id,
        code: card.code,
        amount: card.amount,
        merchantName: card.merchant?.name || 'VITA Sertifika',
        templateName: card.template?.name || 'VITA Evrensel Sertifika',
        isVitaCert: card.isVitaCert || !card.merchantId,
        recipientName: card.recipient?.name || card.buyer.name,
        buyerName: card.buyer.name,
        expiresAt: card.expiresAt,
        status: card.status,
      },
    });
  } catch (err) {
    console.error('Verify-by-code error:', err);
    res.status(500).json({ error: 'Sunucu hatası', valid: false });
  }
});

// ── Confirm redemption by code (merchant panel) ──
redemptionRoutes.post('/confirm-by-code', async (req, res) => {
  try {
    const { code, merchantName } = req.body;
    if (!code) return res.status(400).json({ error: 'Sertifika kodu zorunludur' });

    const card = await prisma.giftCard.findFirst({
      where: { code: code.trim().toUpperCase() },
    });

    if (!card) return res.status(400).json({ error: 'Sertifika bulunamadı' });
    if (card.status !== 'active' && card.status !== 'sent') {
      return res.status(400).json({ error: `Sertifika kullanılamaz (durum: ${card.status})` });
    }

    // Merchant'ı bul (panelden gelen isimle veya ilk onaylı merchant)
    const merchant = await prisma.merchant.findFirst({
      where: merchantName
        ? { name: { contains: merchantName }, approvalStatus: 'approved' }
        : { approvalStatus: 'approved' },
      include: { branches: true },
    });

    if (!merchant || merchant.branches.length === 0) {
      return res.status(400).json({ error: 'İşletme veya şube bulunamadı' });
    }

    const branch = merchant.branches[0];
    const commissionRate = merchant.commissionRate;
    const totalAmount = card.amount;
    const commissionAmount = Math.round(totalAmount * commissionRate);
    const netAmount = totalAmount - commissionAmount;

    const result = await prisma.$transaction(async (tx) => {
      const freshCard = await tx.giftCard.findUnique({ where: { id: card.id } });
      if (!freshCard || (freshCard.status !== 'active' && freshCard.status !== 'sent')) {
        throw new Error('CARD_NOT_AVAILABLE');
      }

      const settlement = await tx.settlement.create({
        data: {
          merchantId: merchant.id,
          totalAmount,
          commissionAmount,
          netAmount,
          commissionRate,
          method: merchant.settlementMethod,
          status: 'pending',
        },
      });

      const redemption = await tx.giftCardRedemption.create({
        data: {
          giftCardId: card.id,
          branchId: branch.id,
          verifiedBy: 'merchant-panel',
          amount: card.amount,
          settlementId: settlement.id,
        },
      });

      await tx.giftCard.update({
        where: { id: card.id },
        data: { status: 'redeemed' },
      });

      // ── Cari Hesap kaydı (LedgerEntry) ──
      // Önceki bakiyeyi bul
      const lastLedger = await (tx as any).ledgerEntry.findFirst({
        where: { merchantId: merchant.id },
        orderBy: { createdAt: 'desc' },
      });
      const prevBalance = lastLedger?.balance || 0;
      const newBalance = prevBalance + netAmount;

      await (tx as any).ledgerEntry.create({
        data: {
          merchantId: merchant.id,
          type: 'Sertifika Kullanım',
          description: `${card.code} — ${branch.name} (${merchant.name})`,
          debit: netAmount,
          credit: 0,
          balance: newBalance,
          relatedId: settlement.id,
        },
      });

      return { settlement, redemption };
    });

    res.json({
      success: true,
      redemption: {
        id: result.redemption.id,
        amount: card.amount,
        branch: branch.name,
        merchantName: merchant.name,
        redeemedAt: result.redemption.redeemedAt,
      },
      settlement: {
        grossAmount: totalAmount,
        commission: commissionAmount,
        commissionRate: `${(commissionRate * 100).toFixed(1)}%`,
        netAmount,
        status: 'pending',
      },
    });
  } catch (err: any) {
    if (err.message === 'CARD_NOT_AVAILABLE') {
      return res.status(400).json({ error: 'Sertifika zaten kullanılmış' });
    }
    console.error('Confirm-by-code error:', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Recent redemptions (merchant panel — load on page open) ──
redemptionRoutes.get('/recent', async (_req, res) => {
  try {
    const recent = await prisma.giftCardRedemption.findMany({
      take: 10,
      orderBy: { redeemedAt: 'desc' },
      include: {
        giftCard: { select: { code: true, amount: true, isVitaCert: true } },
        branch: { select: { name: true } },
      },
    });

    res.json(recent.map(r => ({
      code: r.giftCard.code,
      amount: r.giftCard.amount,
      branch: r.branch?.name || '',
      isVitaCert: r.giftCard.isVitaCert,
      redeemedAt: r.redeemedAt,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Merchant panel — detailed settlements with commission info ──
redemptionRoutes.get('/settlements', async (_req, res) => {
  try {
    const settlements = await prisma.settlement.findMany({
      take: 50,
      orderBy: { createdAt: 'desc' },
      include: {
        merchant: { select: { name: true, commissionRate: true, settlementMethod: true } },
      },
    });

    const totals = {
      totalGross: 0,
      totalCommission: 0,
      totalNet: 0,
      count: settlements.length,
      pending: 0,
      completed: 0,
    };

    const items = settlements.map(s => {
      totals.totalGross += s.totalAmount;
      totals.totalCommission += s.commissionAmount;
      totals.totalNet += s.netAmount;
      if (s.status === 'pending') totals.pending++;
      else totals.completed++;

      return {
        id: s.id,
        merchantName: s.merchant.name,
        totalAmount: s.totalAmount,
        commissionAmount: s.commissionAmount,
        commissionRate: `${(s.commissionRate * 100).toFixed(1)}%`,
        netAmount: s.netAmount,
        method: s.method,
        status: s.status,
        createdAt: s.createdAt,
      };
    });

    res.json({ totals, items });
  } catch (err) {
    console.error('Settlements error:', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// T+1 Batch Settlement: Ödemeler artık anlık değil.
// Akşam batch ile toplanır, ertesi gün admin panelden veya otomatik cron ile ödenir.
// Bkz: src/routes/batchSettlement.ts

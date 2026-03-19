import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMerchant } from '../middleware/auth';

export const merchantPanelRoutes = Router();

// All routes require merchant auth
merchantPanelRoutes.use(requireAuth, requireMerchant);

// ══════════════════════════════════════════════════════
// MERCHANT PANEL — Dashboard, Ledger, Bank Info, etc.
// ══════════════════════════════════════════════════════

// ── Dashboard (updated — includes token redemptions + batch info) ──
merchantPanelRoutes.get('/dashboard', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;

    const [merchant, totalCards, redeemedCards, activeCards, settlements] = await Promise.all([
      prisma.merchant.findUnique({ where: { id: merchantId } }),
      prisma.giftCard.count({ where: { merchantId } }),
      prisma.giftCard.count({ where: { merchantId, status: 'redeemed' } }),
      prisma.giftCard.count({ where: { merchantId, status: { in: ['active', 'sent'] } } }),
      prisma.settlement.aggregate({
        where: { merchantId, status: 'completed' },
        _sum: { netAmount: true, commissionAmount: true, totalAmount: true },
        _count: true,
      }),
    ]);

    // Token redemptions (QR ödemeler)
    const tokenRedemptions = await (prisma as any).tokenRedemption.aggregate({
      where: { merchantId, status: 'completed' },
      _sum: { amount: true, netAmount: true, commissionAmount: true },
      _count: true,
    });

    // Today's activity
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [todayGiftCardRedemptions, todayTokenRedemptions] = await Promise.all([
      prisma.giftCardRedemption.count({
        where: {
          giftCard: { merchantId },
          redeemedAt: { gte: today },
        },
      }),
      (prisma as any).tokenRedemption.count({
        where: {
          merchantId,
          createdAt: { gte: today },
          status: 'completed',
        },
      }),
    ]);

    // Pending batch payments (henüz ödenmemiş)
    const pendingBatches = await (prisma as any).batchSettlement.aggregate({
      where: { merchantId, status: 'pending' },
      _sum: { totalNet: true },
      _count: true,
    });

    // Cari bakiye (son ledger kaydından)
    const lastLedger = await (prisma as any).ledgerEntry.findFirst({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      merchant: {
        name: merchant?.name,
        commissionRate: merchant?.commissionRate,
        settlementMethod: merchant?.settlementMethod,
        bankAccount: merchant?.bankAccount ? `***${merchant.bankAccount.slice(-4)}` : null,
        bankName: merchant?.bankName,
        binIin: merchant?.binIin,
        hasBankInfo: !!(merchant?.bankAccount && merchant?.bankName),
      },
      stats: {
        // Gift card kullanımları
        totalCards,
        redeemedCards,
        activeCards,
        giftCardRevenue: settlements._sum.netAmount || 0,
        giftCardCommission: settlements._sum.commissionAmount || 0,
        giftCardGross: settlements._sum.totalAmount || 0,
        // Token QR ödemeler
        tokenRedemptionCount: tokenRedemptions._count,
        tokenRedemptionGross: tokenRedemptions._sum?.amount || 0,
        tokenRedemptionNet: tokenRedemptions._sum?.netAmount || 0,
        tokenRedemptionCommission: tokenRedemptions._sum?.commissionAmount || 0,
        // Toplam
        totalReceived: (settlements._sum.netAmount || 0) + (tokenRedemptions._sum?.netAmount || 0),
        totalCommissionPaid: (settlements._sum.commissionAmount || 0) + (tokenRedemptions._sum?.commissionAmount || 0),
      },
      today: {
        giftCardRedemptions: todayGiftCardRedemptions,
        tokenRedemptions: todayTokenRedemptions,
        totalRedemptions: todayGiftCardRedemptions + todayTokenRedemptions,
      },
      financial: {
        currentBalance: lastLedger?.balance || 0, // VITA'nın borcu
        pendingPayment: pendingBatches._sum?.totalNet || 0,
        pendingBatchCount: pendingBatches._count,
      },
    });
  } catch (err) {
    console.error('Merchant dashboard error:', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ══════════════════════════════════════════════════════
// CARİ HESAP (Ledger) — Merchant muhasebe görünümü
// Tüm QR kullanımları ve ödeme kayıtları
// ══════════════════════════════════════════════════════

// ── Ledger entries (cari hesap) ──
merchantPanelRoutes.get('/ledger', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    const { limit = '50', type } = req.query;

    const where: any = { merchantId };
    if (type) where.type = type;

    const entries = await (prisma as any).ledgerEntry.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });

    // Özet
    const totals = await (prisma as any).ledgerEntry.aggregate({
      where: { merchantId },
      _sum: { debit: true, credit: true },
    });

    const lastEntry = entries[0];

    res.json({
      entries,
      summary: {
        totalDebit: totals._sum?.debit || 0,   // toplam borçlanma
        totalCredit: totals._sum?.credit || 0,  // toplam ödeme
        currentBalance: lastEntry?.balance || 0, // güncel bakiye
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Cari hesap yüklenemedi' });
  }
});

// ── Token redemption history (QR ile token ödemeleri) ──
merchantPanelRoutes.get('/token-redemptions', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    const { limit = '30' } = req.query;

    const redemptions = await (prisma as any).tokenRedemption.findMany({
      where: { merchantId },
      include: {
        user: { select: { name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });

    res.json(redemptions);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Batch settlement history (toplu ödemeler) ──
merchantPanelRoutes.get('/batch-payments', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    const { limit = '20' } = req.query;

    const batches = await (prisma as any).batchSettlement.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });

    res.json(batches);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ══════════════════════════════════════════════════════
// BANKA BİLGİLERİ — Merchant hesap bilgileri yönetimi
// ══════════════════════════════════════════════════════

// ── Get bank info ──
merchantPanelRoutes.get('/bank-info', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: {
        settlementMethod: true,
        bankAccount: true,
        bankName: true,
        binIin: true,
        contactPhone: true,
        contactEmail: true,
      },
    });

    if (!merchant) return res.status(404).json({ error: 'İş ortağı bulunamadı' });
    res.json(merchant);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Update bank info ──
merchantPanelRoutes.put('/bank-info', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    const { bankAccount, bankName, binIin, settlementMethod, contactPhone, contactEmail } = req.body;

    // Sadece owner güncelleyebilir
    if (req.auth!.role !== 'owner') {
      return res.status(403).json({ error: 'Sadece işletme sahibi banka bilgilerini değiştirebilir' });
    }

    if (!bankAccount || !bankName) {
      return res.status(400).json({ error: 'Hesap numarası ve banka adı zorunludur' });
    }

    const merchant = await prisma.merchant.update({
      where: { id: merchantId },
      data: {
        ...(bankAccount && { bankAccount }),
        ...(bankName && { bankName }),
        ...(binIin && { binIin }),
        ...(settlementMethod && { settlementMethod }),
        ...(contactPhone && { contactPhone }),
        ...(contactEmail && { contactEmail }),
      },
      select: {
        settlementMethod: true,
        bankAccount: true,
        bankName: true,
        binIin: true,
        contactPhone: true,
        contactEmail: true,
      },
    });

    console.log(`🏦 Bank info updated for merchant ${merchantId}`);
    res.json({ success: true, merchant });
  } catch (err) {
    res.status(500).json({ error: 'Banka bilgileri güncellenemedi' });
  }
});

// ── Recent gift card redemptions ──
merchantPanelRoutes.get('/redemptions', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    const { limit = '20' } = req.query;

    const redemptions = await prisma.giftCardRedemption.findMany({
      where: { giftCard: { merchantId } },
      include: {
        giftCard: {
          select: { code: true, amount: true, status: true },
        },
        branch: { select: { name: true, city: { select: { name: true } } } },
        settlement: {
          select: { status: true, netAmount: true, commissionAmount: true, reference: true },
        },
      },
      orderBy: { redeemedAt: 'desc' },
      take: parseInt(limit as string),
    });

    res.json(redemptions);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Settlement history ──
merchantPanelRoutes.get('/settlements', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;

    const settlements = await prisma.settlement.findMany({
      where: { merchantId },
      include: {
        redemptions: {
          include: {
            giftCard: { select: { code: true, amount: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json(settlements);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Branch management ──
merchantPanelRoutes.get('/branches', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    const branches = await prisma.branch.findMany({
      where: { merchantId },
      include: { city: true },
    });
    res.json(branches);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Card templates ──
merchantPanelRoutes.get('/templates', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    const templates = await prisma.cardTemplate.findMany({
      where: { merchantId },
      include: {
        _count: { select: { giftCards: true } },
      },
    });
    res.json(templates);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ══════════════════════════════════════════════════════
// ÇALIŞAN YÖNETİMİ — Merchant staff management
// ══════════════════════════════════════════════════════

// ── List staff ──
merchantPanelRoutes.get('/staff', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    const staff = await prisma.merchantUser.findMany({
      where: { merchantId },
      select: {
        id: true, name: true, phone: true, role: true, isActive: true, createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    res.json(staff);
  } catch (err) {
    res.status(500).json({ error: 'Çalışanlar yüklenemedi' });
  }
});

// ── Add staff ──
merchantPanelRoutes.post('/staff', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    if (req.auth!.role !== 'owner' && req.auth!.role !== 'manager') {
      return res.status(403).json({ error: 'Yetkiniz yok' });
    }

    const { name, phone, role, password } = req.body;
    if (!name || !phone || !password) {
      return res.status(400).json({ error: 'Ad, telefon ve şifre zorunludur' });
    }

    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(password, 10);

    const staff = await prisma.merchantUser.create({
      data: {
        merchantId,
        name,
        phone,
        role: role || 'staff',
        password: hashedPassword,
      },
    });

    res.json({ success: true, staff: { id: staff.id, name: staff.name, phone: staff.phone, role: staff.role } });
  } catch (err: any) {
    if (err.code === 'P2002') {
      return res.status(400).json({ error: 'Bu telefon numarası zaten kayıtlı' });
    }
    res.status(500).json({ error: 'Çalışan eklenemedi' });
  }
});

// ── Update staff ──
merchantPanelRoutes.put('/staff/:id', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    if (req.auth!.role !== 'owner' && req.auth!.role !== 'manager') {
      return res.status(403).json({ error: 'Yetkiniz yok' });
    }

    const { name, role, isActive } = req.body;
    const staff = await prisma.merchantUser.update({
      where: { id: req.params.id },
      data: {
        ...(name && { name }),
        ...(role && { role }),
        ...(isActive !== undefined && { isActive }),
      },
    });
    res.json({ success: true, staff });
  } catch (err) {
    res.status(500).json({ error: 'Çalışan güncellenemedi' });
  }
});

// ── Delete staff ──
merchantPanelRoutes.delete('/staff/:id', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    if (req.auth!.role !== 'owner') {
      return res.status(403).json({ error: 'Sadece işletme sahibi çalışan silebilir' });
    }

    await prisma.merchantUser.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Çalışan silinemedi' });
  }
});

// ══════════════════════════════════════════════════════
// DENETİM SONUÇLARI — Mystery task completions for this merchant
// ══════════════════════════════════════════════════════

merchantPanelRoutes.get('/denetle/reviews', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    const { limit = '20' } = req.query;

    const completions = await prisma.mysteryTaskCompletion.findMany({
      where: { task: { merchantId } },
      include: {
        task: { select: { title: true, category: true } },
        user: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });

    // Average rating
    const avgRating = await prisma.mysteryTaskCompletion.aggregate({
      where: { task: { merchantId }, status: 'approved', rating: { not: null } },
      _avg: { rating: true },
      _count: true,
    });

    res.json({
      completions,
      stats: {
        averageRating: avgRating._avg.rating || 0,
        totalReviews: avgRating._count,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Denetim sonuçları yüklenemedi' });
  }
});

// ══════════════════════════════════════════════════════
// GÖREV TALEPLERİ — Merchant creates mystery tasks
// ══════════════════════════════════════════════════════

merchantPanelRoutes.get('/denetle/tasks', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    const tasks = await prisma.mysteryTask.findMany({
      where: { merchantId },
      include: { _count: { select: { completions: true } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: 'Görevler yüklenemedi' });
  }
});

merchantPanelRoutes.post('/denetle/tasks', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    if (req.auth!.role !== 'owner' && req.auth!.role !== 'manager') {
      return res.status(403).json({ error: 'Yetkiniz yok' });
    }

    const { title, description, category, userReward, maxCompletions } = req.body;
    if (!title || !userReward) {
      return res.status(400).json({ error: 'Başlık ve token ödülü zorunludur' });
    }

    if (userReward < 65 || userReward > 95) {
      return res.status(400).json({ error: 'Token ödülü 65-95 arasında olmalıdır' });
    }

    const vitaMargin = Math.round(userReward * 0.2);
    const businessPayment = userReward + vitaMargin;

    const task = await prisma.mysteryTask.create({
      data: {
        merchantId,
        title,
        description,
        category: category || 'service',
        userReward,
        vitaMargin,
        businessPayment,
        maxCompletions: maxCompletions || 1,
      },
    });

    res.json({ success: true, task });
  } catch (err) {
    res.status(500).json({ error: 'Görev oluşturulamadı' });
  }
});

// ══════════════════════════════════════════════════════
// MERCHANT PROFILE UPDATE — İşletme profili güncelleme
// ══════════════════════════════════════════════════════

merchantPanelRoutes.put('/profile', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    if (req.auth!.role !== 'owner' && req.auth!.role !== 'manager') {
      return res.status(403).json({ error: 'Yetkiniz yok' });
    }

    const { name, description, category, contactPhone, contactEmail } = req.body;

    const merchant = await prisma.merchant.update({
      where: { id: merchantId },
      data: {
        ...(name && { name }),
        ...(description && { description }),
        ...(category && { category }),
        ...(contactPhone && { contactPhone }),
        ...(contactEmail && { contactEmail }),
      },
    });

    res.json({ success: true, merchant });
  } catch (err) {
    res.status(500).json({ error: 'Profil güncellenemedi' });
  }
});

// ── Merchant performance stats ──
merchantPanelRoutes.get('/performance', async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId!;
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [monthlyRedemptions, monthlyTokenPayments, branchPerformance] = await Promise.all([
      prisma.giftCardRedemption.count({
        where: { giftCard: { merchantId }, redeemedAt: { gte: thirtyDaysAgo } },
      }),
      (prisma as any).tokenRedemption.aggregate({
        where: { merchantId, createdAt: { gte: thirtyDaysAgo }, status: 'completed' },
        _sum: { amount: true },
        _count: true,
      }),
      prisma.branch.findMany({
        where: { merchantId },
        include: {
          _count: { select: { redemptions: true } },
          city: { select: { name: true } },
        },
      }),
    ]);

    res.json({
      monthly: {
        giftCardRedemptions: monthlyRedemptions,
        tokenPayments: monthlyTokenPayments._count,
        tokenVolume: monthlyTokenPayments._sum?.amount || 0,
      },
      branches: branchPerformance,
    });
  } catch (err) {
    res.status(500).json({ error: 'Performans verileri yüklenemedi' });
  }
});

import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, requireAdmin } from '../middleware/auth';

export const adminRoutes = Router();

// All admin routes require auth + admin role
adminRoutes.use(requireAuth, requireAdmin);

// ── Dashboard stats ──
adminRoutes.get('/dashboard', async (_req, res) => {
  try {
    const [users, merchants, cards, revenue, pendingMerchants] = await Promise.all([
      prisma.user.count(),
      prisma.merchant.count({ where: { approvalStatus: 'approved' } }),
      prisma.giftCard.count(),
      prisma.settlement.aggregate({
        where: { status: 'completed' },
        _sum: { commissionAmount: true, totalAmount: true },
      }),
      prisma.merchant.count({ where: { approvalStatus: 'pending' } }),
    ]);

    const redeemed = await prisma.giftCard.count({ where: { status: 'redeemed' } });

    res.json({
      totalUsers: users,
      totalMerchants: merchants,
      pendingMerchants,
      totalCards: cards,
      redeemedCards: redeemed,
      totalRevenue: revenue._sum.totalAmount || 0,
      totalCommission: revenue._sum.commissionAmount || 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Merchant approval ──
adminRoutes.get('/merchants', async (req, res) => {
  try {
    const { status } = req.query;
    const merchants = await prisma.merchant.findMany({
      where: status ? { approvalStatus: status as string } : undefined,
      include: {
        branches: { include: { city: true } },
        _count: { select: { giftCards: true, settlements: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(merchants);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

adminRoutes.post('/merchants/:id/approve', async (req, res) => {
  try {
    const merchant = await prisma.merchant.update({
      where: { id: req.params.id },
      data: { approvalStatus: 'approved' },
    });
    res.json({ success: true, merchant });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

adminRoutes.post('/merchants/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;
    const merchant = await prisma.merchant.update({
      where: { id: req.params.id },
      data: { approvalStatus: 'rejected', rejectionReason: reason },
    });
    res.json({ success: true, merchant });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── City management ──
adminRoutes.get('/cities', async (_req, res) => {
  try {
    const cities = await prisma.city.findMany({
      include: { _count: { select: { branches: true } } },
      orderBy: { sortOrder: 'asc' },
    });
    res.json(cities);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

adminRoutes.post('/cities', async (req, res) => {
  try {
    const { name, nameEn, region } = req.body;
    const city = await prisma.city.create({
      data: { name, nameEn, region },
    });
    res.json(city);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── User management ──
adminRoutes.get('/users', async (req, res) => {
  try {
    const { search, limit = '50' } = req.query;
    const where: any = {};
    if (search) {
      where.OR = [
        { name: { contains: search as string } },
        { phone: { contains: search as string } },
      ];
    }
    const users = await prisma.user.findMany({
      where,
      select: {
        id: true, name: true, phone: true, email: true,
        tokenBalance: true, referralCode: true, createdAt: true,
        _count: { select: { purchasedCards: true, receivedCards: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Commission rate management ──
adminRoutes.put('/merchants/:id/commission', async (req, res) => {
  try {
    const { commissionRate } = req.body;
    if (commissionRate < 0 || commissionRate > 0.5) {
      return res.status(400).json({ error: 'Komisyon oranı %0 ile %50 arasında olmalıdır' });
    }
    const merchant = await prisma.merchant.update({
      where: { id: req.params.id },
      data: { commissionRate },
    });
    res.json({ success: true, merchant });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ══════════════════════════════════════════════════════
// LEDGER — Admin: tüm merchant'ların cari hesap özeti
// ══════════════════════════════════════════════════════

// ── All merchants' outstanding balances ──
adminRoutes.get('/ledger/summary', async (_req, res) => {
  try {
    // Her merchant için son cari bakiyeyi bul
    const merchants = await prisma.merchant.findMany({
      where: { approvalStatus: 'approved' },
      select: {
        id: true,
        name: true,
        bankAccount: true,
        bankName: true,
        settlementMethod: true,
        commissionRate: true,
      },
    });

    const summaries: any[] = [];

    for (const merchant of merchants) {
      const lastLedger = await (prisma as any).ledgerEntry.findFirst({
        where: { merchantId: merchant.id },
        orderBy: { createdAt: 'desc' },
      });

      const pendingBatches = await (prisma as any).batchSettlement.count({
        where: { merchantId: merchant.id, status: 'pending' },
      });

      if (lastLedger || pendingBatches > 0) {
        summaries.push({
          merchant: {
            id: merchant.id,
            name: merchant.name,
            bankAccount: merchant.bankAccount ? `***${merchant.bankAccount.slice(-4)}` : 'Belirtilmedi',
            bankName: merchant.bankName,
            hasBankInfo: !!(merchant.bankAccount && merchant.bankName),
          },
          balance: lastLedger?.balance || 0,
          pendingBatches,
        });
      }
    }

    // VITA'nın toplam borcu
    const totalOwed = summaries.reduce((sum, s) => sum + s.balance, 0);

    res.json({
      merchants: summaries.sort((a, b) => b.balance - a.balance),
      totalOwed,
      merchantCount: summaries.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Specific merchant ledger (admin view) ──
adminRoutes.get('/ledger/:merchantId', async (req, res) => {
  try {
    const { merchantId } = req.params;
    const { limit = '50' } = req.query;

    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: { id: true, name: true, bankAccount: true, bankName: true, binIin: true, settlementMethod: true },
    });

    if (!merchant) return res.status(404).json({ error: 'İş ortağı bulunamadı' });

    const entries = await (prisma as any).ledgerEntry.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });

    const totals = await (prisma as any).ledgerEntry.aggregate({
      where: { merchantId },
      _sum: { debit: true, credit: true },
    });

    res.json({
      merchant,
      entries,
      summary: {
        totalDebit: totals._sum?.debit || 0,
        totalCredit: totals._sum?.credit || 0,
        currentBalance: entries[0]?.balance || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Token redemptions overview (all merchants) ──
adminRoutes.get('/token-redemptions', async (req, res) => {
  try {
    const { limit = '50', merchantId } = req.query;
    const where: any = {};
    if (merchantId) where.merchantId = merchantId;

    const redemptions = await (prisma as any).tokenRedemption.findMany({
      where,
      include: {
        user: { select: { name: true, phone: true } },
        merchant: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });

    const totals = await (prisma as any).tokenRedemption.aggregate({
      where: { status: 'completed' },
      _sum: { amount: true, netAmount: true, commissionAmount: true },
      _count: true,
    });

    res.json({
      redemptions,
      totals: {
        count: totals._count,
        totalAmount: totals._sum?.amount || 0,
        totalNet: totals._sum?.netAmount || 0,
        totalCommission: totals._sum?.commissionAmount || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ══════════════════════════════════════════════════════
// ANALYTICS — Gelişmiş analitik endpoint'leri
// ══════════════════════════════════════════════════════

// ── Token economy overview ──
adminRoutes.get('/analytics/tokens', async (_req, res) => {
  try {
    const [totalInCirculation, earnedToday, spentToday, tokenTransactions] = await Promise.all([
      prisma.user.aggregate({ _sum: { tokenBalance: true } }),
      prisma.tokenTransaction.aggregate({
        where: { amount: { gt: 0 }, createdAt: { gte: new Date(new Date().setHours(0,0,0,0)) } },
        _sum: { amount: true },
      }),
      prisma.tokenTransaction.aggregate({
        where: { amount: { lt: 0 }, createdAt: { gte: new Date(new Date().setHours(0,0,0,0)) } },
        _sum: { amount: true },
      }),
      prisma.tokenTransaction.groupBy({
        by: ['type'],
        _sum: { amount: true },
        _count: true,
      }),
    ]);

    res.json({
      totalInCirculation: totalInCirculation._sum.tokenBalance || 0,
      earnedToday: earnedToday._sum.amount || 0,
      spentToday: Math.abs(spentToday._sum.amount || 0),
      byType: tokenTransactions,
    });
  } catch (err) {
    res.status(500).json({ error: 'Analitik yüklenemedi' });
  }
});

// ── NearbyMe statistics ──
adminRoutes.get('/analytics/nearby', async (_req, res) => {
  try {
    const today = new Date(new Date().setHours(0,0,0,0));
    const [activeLocations, totalMatches, acceptedMatches, totalMessages] = await Promise.all([
      (prisma as any).userLocation.count({ where: { isActive: true } }),
      (prisma as any).nearbyMatch.count(),
      (prisma as any).nearbyMatch.count({ where: { status: 'accepted' } }),
      (prisma as any).nearbyMessage.count(),
    ]);

    res.json({
      activeUsers: activeLocations,
      totalMatches,
      acceptedMatches,
      totalMessages,
    });
  } catch (err) {
    res.status(500).json({ error: 'NearbyMe analitik yüklenemedi' });
  }
});

// ── Referral statistics ──
adminRoutes.get('/analytics/referral', async (_req, res) => {
  try {
    const [totalReferrals, activated, totalTokens, mysteryBoxes, leaderboard] = await Promise.all([
      prisma.referral.count(),
      prisma.referral.count({ where: { status: 'activated' } }),
      prisma.referral.aggregate({ _sum: { tokensAwarded: true } }),
      (prisma as any).mysteryBoxReward.count({ where: { claimedAt: { not: null } } }),
      (prisma as any).leaderboardEntry.findMany({
        orderBy: { activationCount: 'desc' },
        take: 20,
      }),
    ]);

    // Influencer codes
    const influencerCodes = await (prisma as any).influencerCode.findMany({
      orderBy: { usageCount: 'desc' },
    });

    res.json({
      totalReferrals,
      activated,
      totalTokensDistributed: totalTokens._sum.tokensAwarded || 0,
      mysteryBoxesClaimed: mysteryBoxes,
      leaderboard,
      influencerCodes,
    });
  } catch (err) {
    res.status(500).json({ error: 'Referans analitik yüklenemedi' });
  }
});

// ── Jobs statistics ──
adminRoutes.get('/analytics/jobs', async (_req, res) => {
  try {
    const [activeJobs, totalApplications, completedJobs, totalBudget] = await Promise.all([
      prisma.job.count({ where: { status: 'open' } }),
      prisma.jobApplication.count(),
      prisma.job.count({ where: { status: 'completed' } }),
      prisma.job.aggregate({ _sum: { budget: true } }),
    ]);

    const recentJobs = await prisma.job.findMany({
      include: {
        employer: { select: { name: true } },
        _count: { select: { applications: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    res.json({
      activeJobs,
      totalApplications,
      completedJobs,
      totalBudget: totalBudget._sum.budget || 0,
      recentJobs,
    });
  } catch (err) {
    res.status(500).json({ error: 'Jobs analitik yüklenemedi' });
  }
});

// ══════════════════════════════════════════════════════
// GÖZLEMLE (Denetle) — Mystery task management
// ══════════════════════════════════════════════════════

adminRoutes.get('/denetle/tasks', async (req, res) => {
  try {
    const { status, limit = '50' } = req.query;
    const where: any = {};
    if (status) where.isActive = status === 'active';

    const tasks = await prisma.mysteryTask.findMany({
      where,
      include: {
        merchant: { select: { name: true } },
        _count: { select: { completions: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });

    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: 'Görevler yüklenemedi' });
  }
});

adminRoutes.get('/denetle/completions', async (req, res) => {
  try {
    const { status = 'pending', limit = '50' } = req.query;
    const completions = await prisma.mysteryTaskCompletion.findMany({
      where: { status: status as string },
      include: {
        task: { include: { merchant: { select: { name: true } } } },
        user: { select: { name: true, phone: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });

    res.json(completions);
  } catch (err) {
    res.status(500).json({ error: 'Denetim sonuçları yüklenemedi' });
  }
});

adminRoutes.post('/denetle/completions/:id/approve', async (req, res) => {
  try {
    const completion = await prisma.mysteryTaskCompletion.update({
      where: { id: req.params.id },
      data: { status: 'approved', approvedBy: req.auth!.id, approvedAt: new Date() },
    });

    // Award tokens to user
    const task = await prisma.mysteryTask.findUnique({ where: { id: completion.taskId } });
    if (task) {
      await prisma.user.update({
        where: { id: completion.userId },
        data: { tokenBalance: { increment: completion.tokensAwarded } },
      });
      await prisma.tokenTransaction.create({
        data: {
          userId: completion.userId,
          amount: completion.tokensAwarded,
          type: 'earn_activity',
          source: `Gözlemle: ${task.title}`,
          balanceAfter: 0, // will be calculated
        },
      });
    }

    res.json({ success: true, completion });
  } catch (err) {
    res.status(500).json({ error: 'Onay hatası' });
  }
});

adminRoutes.post('/denetle/completions/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;
    const completion = await prisma.mysteryTaskCompletion.update({
      where: { id: req.params.id },
      data: { status: 'rejected', approvedBy: req.auth!.id },
    });
    res.json({ success: true, completion });
  } catch (err) {
    res.status(500).json({ error: 'Ret hatası' });
  }
});

// ══════════════════════════════════════════════════════
// NOTIFICATION MANAGEMENT — Admin bildirim gönderme
// ══════════════════════════════════════════════════════

adminRoutes.post('/notifications/send', async (req, res) => {
  try {
    const { target, targetValue, type, title, body, icon, actionType, actionTarget } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'Başlık ve mesaj zorunludur' });
    }

    let userIds: string[] = [];

    if (target === 'all') {
      const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true } });
      userIds = users.map(u => u.id);
    } else if (target === 'city') {
      const users = await prisma.user.findMany({ where: { cityId: targetValue, isActive: true }, select: { id: true } });
      userIds = users.map(u => u.id);
    } else if (target === 'user') {
      userIds = [targetValue];
    }

    const notifications = await prisma.notification.createMany({
      data: userIds.map(userId => ({
        userId,
        type: type || 'system',
        title,
        body,
        icon: icon || '📢',
        actionType: actionType || 'none',
        actionTarget,
      })),
    });

    res.json({ success: true, sentTo: userIds.length, count: notifications.count });
  } catch (err) {
    res.status(500).json({ error: 'Bildirim gönderilemedi' });
  }
});

adminRoutes.get('/notifications/recent', async (req, res) => {
  try {
    const { limit = '50' } = req.query;
    // Get unique notifications (grouped by title+body to avoid showing duplicates for mass sends)
    const notifications = await prisma.notification.findMany({
      distinct: ['title', 'body'],
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
      include: {
        user: { select: { name: true } },
      },
    });

    res.json(notifications);
  } catch (err) {
    res.status(500).json({ error: 'Bildirimler yüklenemedi' });
  }
});

// ══════════════════════════════════════════════════════
// USER MANAGEMENT — Gelişmiş kullanıcı yönetimi
// ══════════════════════════════════════════════════════

adminRoutes.get('/users/:id', async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.params.id },
      include: {
        tokenHistory: { orderBy: { createdAt: 'desc' }, take: 20 },
        referralsSent: { orderBy: { createdAt: 'desc' }, take: 10 },
        purchasedCards: { orderBy: { createdAt: 'desc' }, take: 10 },
        _count: {
          select: {
            purchasedCards: true,
            receivedCards: true,
            referralsSent: true,
            tokenHistory: true,
          },
        },
      },
    });

    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Kullanıcı yüklenemedi' });
  }
});

adminRoutes.put('/users/:id/status', async (req, res) => {
  try {
    const { isActive } = req.body;
    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: { isActive },
    });
    res.json({ success: true, user: { id: user.id, name: user.name, isActive: user.isActive } });
  } catch (err) {
    res.status(500).json({ error: 'Kullanıcı durumu güncellenemedi' });
  }
});

// ══════════════════════════════════════════════════════
// GIFT CARDS — Admin görünümü
// ══════════════════════════════════════════════════════

adminRoutes.get('/gift-cards', async (req, res) => {
  try {
    const { status, merchantId, limit = '50' } = req.query;
    const where: any = {};
    if (status) where.status = status;
    if (merchantId) where.merchantId = merchantId;

    const [cards, stats] = await Promise.all([
      prisma.giftCard.findMany({
        where,
        include: {
          buyer: { select: { name: true, phone: true } },
          merchant: { select: { name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit as string),
      }),
      Promise.all([
        prisma.giftCard.count(),
        prisma.giftCard.count({ where: { status: 'active' } }),
        prisma.giftCard.count({ where: { status: 'redeemed' } }),
        prisma.giftCard.count({ where: { status: 'expired' } }),
        prisma.giftCard.aggregate({ _sum: { amount: true } }),
      ]),
    ]);

    res.json({
      cards,
      stats: {
        total: stats[0],
        active: stats[1],
        redeemed: stats[2],
        expired: stats[3],
        totalValue: stats[4]._sum.amount || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Hediye kartları yüklenemedi' });
  }
});

// ══════════════════════════════════════════════════════
// INFLUENCER CODES — Yönetim
// ══════════════════════════════════════════════════════

adminRoutes.post('/influencer-codes', async (req, res) => {
  try {
    const { code, influencerName, platform, bonusMultiplier, specialReward, maxUsage, expiresAt } = req.body;

    if (!code || !influencerName) {
      return res.status(400).json({ error: 'Kod ve influencer adı zorunludur' });
    }

    const influencerCode = await (prisma as any).influencerCode.create({
      data: {
        code: code.toUpperCase(),
        influencerName,
        platform,
        bonusMultiplier: bonusMultiplier || 1.0,
        specialReward,
        maxUsage,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
    });

    res.json({ success: true, influencerCode });
  } catch (err) {
    res.status(500).json({ error: 'Influencer kodu oluşturulamadı' });
  }
});

adminRoutes.put('/influencer-codes/:id', async (req, res) => {
  try {
    const { isActive, maxUsage, expiresAt, bonusMultiplier } = req.body;
    const code = await (prisma as any).influencerCode.update({
      where: { id: req.params.id },
      data: {
        ...(isActive !== undefined && { isActive }),
        ...(maxUsage !== undefined && { maxUsage }),
        ...(expiresAt && { expiresAt: new Date(expiresAt) }),
        ...(bonusMultiplier && { bonusMultiplier }),
      },
    });
    res.json({ success: true, code });
  } catch (err) {
    res.status(500).json({ error: 'Influencer kodu güncellenemedi' });
  }
});

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

export const adminPublicRoutes = Router();

// ══════════════════════════════════════════════════════
// PUBLIC READ-ONLY ADMIN ENDPOINTS (NO JWT AUTH)
// ══════════════════════════════════════════════════════

// ── Dashboard stats ──
adminPublicRoutes.get('/dashboard', async (_req: Request, res: Response) => {
  try {
    const [users, merchants, cards, revenue, pendingMerchants] = await Promise.all([
      prisma.user.count(),
      prisma.merchant.count({ where: { approvalStatus: 'approved' } }),
      prisma.giftCard.count(),
      prisma.settlement.aggregate({
        _sum: { commissionAmount: true, totalAmount: true, netAmount: true },
        _count: true,
      }),
      prisma.merchant.count({ where: { approvalStatus: 'pending' } }),
    ]);

    const redeemed = await prisma.giftCard.count({ where: { status: 'redeemed' } });

    // Token dolaşım — tüm kullanıcıların token bakiyesi toplamı
    const tokenCirculation = await prisma.user.aggregate({ _sum: { tokenBalance: true } });

    // NearbyMe aktif kullanıcı sayısı
    const nearbyActive = await (prisma as any).userLocation.count({ where: { isActive: true } });

    // Günlük aktif kullanıcı — bugün token işlemi yapanlar
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - 7);

    const dailyActiveTokenTx = await prisma.tokenTransaction.findMany({
      where: { createdAt: { gte: todayStart } },
      select: { userId: true },
      distinct: ['userId'],
    });

    const weeklyActiveTokenTx = await prisma.tokenTransaction.findMany({
      where: { createdAt: { gte: weekStart } },
      select: { userId: true },
      distinct: ['userId'],
    });

    // Aylık platform geliri (komisyon)
    const monthStart = new Date(todayStart.getFullYear(), todayStart.getMonth(), 1);
    const monthlyRevenue = await prisma.settlement.aggregate({
      where: { createdAt: { gte: monthStart } },
      _sum: { commissionAmount: true },
    });

    res.json({
      totalUsers: users,
      totalMerchants: merchants,
      pendingMerchants,
      totalCards: cards,
      redeemedCards: redeemed,
      totalRevenue: revenue._sum.totalAmount || 0,
      totalCommission: revenue._sum.commissionAmount || 0,
      totalNet: revenue._sum.netAmount || 0,
      settlementCount: revenue._count,
      totalTokensInCirculation: tokenCirculation._sum.tokenBalance || 0,
      nearbyActiveUsers: nearbyActive || 0,
      dailyActiveUsers: dailyActiveTokenTx.length,
      weeklyActiveUsers: weeklyActiveTokenTx.length,
      monthlyRevenue: monthlyRevenue._sum.commissionAmount || 0,
    });
  } catch (err) {
    console.error('Dashboard stats error:', err);
    res.status(500).json({ error: 'Failed to load dashboard stats', stats: {} });
  }
});

// ── Merchants list ──
adminPublicRoutes.get('/merchants', async (req: Request, res: Response) => {
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
    console.error('Merchants list error:', err);
    res.status(500).json({ error: 'Failed to load merchants', merchants: [] });
  }
});

// ── Users list with search ──
adminPublicRoutes.get('/users', async (req: Request, res: Response) => {
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
        id: true,
        name: true,
        phone: true,
        email: true,
        tokenBalance: true,
        referralCode: true,
        createdAt: true,
        _count: { select: { purchasedCards: true, receivedCards: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });
    res.json(users);
  } catch (err) {
    console.error('Users list error:', err);
    res.status(500).json({ error: 'Failed to load users', users: [] });
  }
});

// ── Cities list ──
adminPublicRoutes.get('/cities', async (_req: Request, res: Response) => {
  try {
    const cities = await prisma.city.findMany({
      include: { _count: { select: { branches: true } } },
      orderBy: { sortOrder: 'asc' },
    });
    res.json(cities);
  } catch (err) {
    console.error('Cities list error:', err);
    res.status(500).json({ error: 'Failed to load cities', cities: [] });
  }
});

// ── Gift cards ──
adminPublicRoutes.get('/gift-cards', async (req: Request, res: Response) => {
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
    console.error('Gift cards error:', err);
    res.status(500).json({ error: 'Failed to load gift cards', cards: [], stats: {} });
  }
});

// ── Settlements summary ──
adminPublicRoutes.get('/settlements', async (_req: Request, res: Response) => {
  try {
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
            bankAccount: merchant.bankAccount ? `***${merchant.bankAccount.slice(-4)}` : 'Not specified',
            bankName: merchant.bankName,
            hasBankInfo: !!(merchant.bankAccount && merchant.bankName),
          },
          balance: lastLedger?.balance || 0,
          pendingBatches,
        });
      }
    }

    const totalOwed = summaries.reduce((sum, s) => sum + s.balance, 0);

    res.json({
      merchants: summaries.sort((a, b) => b.balance - a.balance),
      totalOwed,
      merchantCount: summaries.length,
    });
  } catch (err) {
    console.error('Settlements summary error:', err);
    res.status(500).json({ error: 'Failed to load settlements', merchants: [], totalOwed: 0, merchantCount: 0 });
  }
});

// ── Token redemptions ──
adminPublicRoutes.get('/token-redemptions', async (req: Request, res: Response) => {
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
    console.error('Token redemptions error:', err);
    res.status(500).json({ error: 'Failed to load token redemptions', redemptions: [], totals: {} });
  }
});

// ── Token economy analytics ──
adminPublicRoutes.get('/analytics/tokens', async (_req: Request, res: Response) => {
  try {
    const [totalInCirculation, earnedToday, spentToday, tokenTransactions] = await Promise.all([
      prisma.user.aggregate({ _sum: { tokenBalance: true } }),
      prisma.tokenTransaction.aggregate({
        where: { amount: { gt: 0 }, createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
        _sum: { amount: true },
      }),
      prisma.tokenTransaction.aggregate({
        where: { amount: { lt: 0 }, createdAt: { gte: new Date(new Date().setHours(0, 0, 0, 0)) } },
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
    console.error('Token analytics error:', err);
    res.status(500).json({ error: 'Failed to load token analytics', totalInCirculation: 0, earnedToday: 0, spentToday: 0, byType: [] });
  }
});

// ── NearbyMe analytics ──
adminPublicRoutes.get('/analytics/nearby', async (_req: Request, res: Response) => {
  try {
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
    console.error('NearbyMe analytics error:', err);
    res.status(500).json({ error: 'Failed to load NearbyMe analytics', activeUsers: 0, totalMatches: 0, acceptedMatches: 0, totalMessages: 0 });
  }
});

// ── Referral analytics ──
adminPublicRoutes.get('/analytics/referral', async (_req: Request, res: Response) => {
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
    console.error('Referral analytics error:', err);
    res.status(500).json({ error: 'Failed to load referral analytics', totalReferrals: 0, activated: 0, totalTokensDistributed: 0, mysteryBoxesClaimed: 0, leaderboard: [], influencerCodes: [] });
  }
});

// ── Jobs analytics ──
adminPublicRoutes.get('/analytics/jobs', async (_req: Request, res: Response) => {
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
    console.error('Jobs analytics error:', err);
    res.status(500).json({ error: 'Failed to load jobs analytics', activeJobs: 0, totalApplications: 0, completedJobs: 0, totalBudget: 0, recentJobs: [] });
  }
});

// ── Mystery tasks ──
adminPublicRoutes.get('/denetle/tasks', async (req: Request, res: Response) => {
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
    console.error('Mystery tasks error:', err);
    res.status(500).json({ error: 'Failed to load mystery tasks', tasks: [] });
  }
});

// ── Task completions ──
adminPublicRoutes.get('/denetle/completions', async (req: Request, res: Response) => {
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
    console.error('Task completions error:', err);
    res.status(500).json({ error: 'Failed to load task completions', completions: [] });
  }
});

// ── Recent notifications ──
adminPublicRoutes.get('/notifications/recent', async (req: Request, res: Response) => {
  try {
    const { limit = '50' } = req.query;
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
    console.error('Recent notifications error:', err);
    res.status(500).json({ error: 'Failed to load notifications', notifications: [] });
  }
});

// ── Commissions (VITA's earnings) ──
adminPublicRoutes.get('/commissions', async (_req: Request, res: Response) => {
  try {
    const merchants = await prisma.merchant.findMany({
      where: { approvalStatus: 'approved' },
      select: {
        id: true,
        name: true,
        commissionRate: true,
      },
      orderBy: { name: 'asc' },
    });

    const commissionsData: any[] = [];

    for (const merchant of merchants) {
      const settlements = await prisma.settlement.aggregate({
        where: { merchantId: merchant.id },
        _sum: { commissionAmount: true, totalAmount: true },
      });

      commissionsData.push({
        merchant: {
          id: merchant.id,
          name: merchant.name,
          commissionRate: merchant.commissionRate,
        },
        settlementTotal: settlements._sum.totalAmount || 0,
        commissionEarned: settlements._sum.commissionAmount || 0,
      });
    }

    // Calculate stats
    const totalEarned = commissionsData.reduce((sum, m) => sum + m.commissionEarned, 0);
    const avgRate = merchants.length > 0
      ? (merchants.reduce((sum, m) => sum + (m.commissionRate || 0), 0) / merchants.length)
      : 0;
    const maxRate = merchants.length > 0
      ? Math.max(...merchants.map(m => m.commissionRate || 0))
      : 0;

    res.json({
      commissions: commissionsData,
      stats: {
        totalEarned,
        averageRate: avgRate,
        maxRate,
        merchantCount: merchants.length,
      },
    });
  } catch (err) {
    console.error('Commissions error:', err);
    res.status(500).json({ error: 'Failed to load commissions', commissions: [], stats: {} });
  }
});

// ── Batch Settlements ──
adminPublicRoutes.get('/batch-settlements', async (_req: Request, res: Response) => {
  try {
    const batches = await (prisma as any).batchSettlement.findMany({
      include: {
        merchantObj: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const totalBatches = batches.length;
    const totalAmount = batches.reduce((sum: number, b: any) => sum + (b.totalNet || 0), 0);
    const pendingBatches = batches.filter((b: any) => b.status === 'pending').length;

    res.json({
      batches,
      stats: {
        totalBatches,
        totalAmount,
        pendingBatches,
      },
    });
  } catch (err) {
    console.error('Batch settlements error:', err);
    res.status(500).json({ error: 'Failed to load batch settlements', batches: [], stats: {} });
  }
});

// ── NearbyMe detailed data (check-ins, matches, etc.) ──
adminPublicRoutes.get('/nearby/details', async (_req: Request, res: Response) => {
  try {
    const [recentLocations, recentMatches] = await Promise.all([
      (prisma as any).userLocation.findMany({
        include: { user: { select: { id: true, name: true } } },
        orderBy: { lastSeen: 'desc' },
        take: 20,
      }),
      (prisma as any).nearbyMatch.findMany({
        include: {
          user1: { select: { id: true, name: true } },
          user2: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);

    res.json({
      checkins: recentLocations,
      matches: recentMatches,
      activities: [],
      moderation: [],
    });
  } catch (err) {
    console.error('NearbyMe details error:', err);
    res.status(500).json({
      error: 'Failed to load nearby details',
      checkins: [],
      matches: [],
      activities: [],
      moderation: [],
    });
  }
});

// ── Mystery Tasks with completion stats ──
adminPublicRoutes.get('/denetle/tasks/stats', async (_req: Request, res: Response) => {
  try {
    const [activeTasks, completedCompletions, pendingCompletions, approvedCompletions] = await Promise.all([
      prisma.mysteryTask.count({ where: { isActive: true } }),
      prisma.mysteryTaskCompletion.count({ where: { status: 'completed' } }),
      prisma.mysteryTaskCompletion.count({ where: { status: 'pending' } }),
      prisma.mysteryTaskCompletion.count({ where: { status: 'approved' } }),
    ]);

    const tasks = await prisma.mysteryTask.findMany({
      where: { isActive: true },
      include: {
        merchant: { select: { name: true } },
        _count: { select: { completions: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    res.json({
      tasks,
      stats: {
        totalTasks: activeTasks,
        completedCompletions,
        pendingCompletions,
        approvedCompletions,
      },
    });
  } catch (err) {
    console.error('Mystery tasks stats error:', err);
    res.status(500).json({
      error: 'Failed to load mystery tasks stats',
      tasks: [],
      stats: { totalTasks: 0, completedCompletions: 0, pendingCompletions: 0, approvedCompletions: 0 },
    });
  }
});

// ── Token transactions for table ──
adminPublicRoutes.get('/analytics/tokens/transactions', async (req: Request, res: Response) => {
  try {
    const { limit = '50' } = req.query;

    const transactions = await prisma.tokenTransaction.findMany({
      include: { user: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });

    res.json(transactions);
  } catch (err) {
    console.error('Token transactions error:', err);
    res.status(500).json({ error: 'Failed to load token transactions', transactions: [] });
  }
});

// ── Prepare Batch Settlement ──
// Toplam bekleyen settlement'ları merchantId bazında batch'lere böler
adminPublicRoutes.post('/prepare-batch', async (_req: Request, res: Response) => {
  try {
    const today = new Date().toISOString().split('T')[0]; // "2026-03-20"

    // Henüz batch'e atanmamış pending settlement'ları bul
    const pendingSettlements = await prisma.settlement.findMany({
      where: { status: 'pending', batchId: null },
      include: { merchant: { select: { id: true, name: true, bankAccount: true, bankName: true } } },
    });

    if (pendingSettlements.length === 0) {
      res.json({ message: 'Bekleyen settlement yok', batchCount: 0 });
      return;
    }

    // MerchantId bazında grupla
    const byMerchant: Record<string, typeof pendingSettlements> = {};
    for (const s of pendingSettlements) {
      if (!byMerchant[s.merchantId]) byMerchant[s.merchantId] = [];
      byMerchant[s.merchantId].push(s);
    }

    let batchCount = 0;
    for (const [merchantId, settlements] of Object.entries(byMerchant)) {
      const totalGross = settlements.reduce((sum: number, s: any) => sum + s.totalAmount, 0);
      const totalCommission = settlements.reduce((sum: number, s: any) => sum + s.commissionAmount, 0);
      const totalNet = settlements.reduce((sum: number, s: any) => sum + s.netAmount, 0);
      const merchant = settlements[0].merchant;

      // Batch oluştur
      const batch = await (prisma as any).batchSettlement.create({
        data: {
          batchDate: today,
          merchantId,
          totalGross,
          totalCommission,
          totalNet,
          itemCount: settlements.length,
          method: 'havale',
          bankAccount: merchant.bankAccount,
          bankName: merchant.bankName,
          status: 'pending',
        },
      });

      // Settlement'ları batch'e ata
      await prisma.settlement.updateMany({
        where: { id: { in: settlements.map((s: any) => s.id) } },
        data: { batchId: batch.id, status: 'batched' },
      });

      batchCount++;
    }

    res.json({ message: 'Batch hazırlandı', batchCount, totalSettlements: pendingSettlements.length });
  } catch (err) {
    console.error('Prepare batch error:', err);
    res.status(500).json({ error: 'Batch hazırlama başarısız' });
  }
});

// ── Run Batch Settlement ──
// Bekleyen batch'leri "completed" olarak işaretle + ledger kaydı oluştur
adminPublicRoutes.post('/run-batch', async (_req: Request, res: Response) => {
  try {
    const pendingBatches = await (prisma as any).batchSettlement.findMany({
      where: { status: 'pending' },
      include: { merchantObj: { select: { name: true } } },
    });

    if (pendingBatches.length === 0) {
      res.json({ message: 'Bekleyen batch yok', processedCount: 0 });
      return;
    }

    let processedCount = 0;
    for (const batch of pendingBatches) {
      // Batch'i completed yap
      await (prisma as any).batchSettlement.update({
        where: { id: batch.id },
        data: { status: 'completed', processedAt: new Date(), processedBy: 'admin' },
      });

      // İlgili settlement'ları da completed yap
      await prisma.settlement.updateMany({
        where: { batchId: batch.id },
        data: { status: 'completed', processedAt: new Date() },
      });

      // Ledger kaydı oluştur — merchant'a ödeme (credit)
      const lastLedger = await (prisma as any).ledgerEntry.findFirst({
        where: { merchantId: batch.merchantId },
        orderBy: { createdAt: 'desc' },
      });
      const prevBalance = lastLedger?.balance || 0;
      const newBalance = prevBalance - batch.totalNet; // ödeme yapıldı, borç azaldı

      await (prisma as any).ledgerEntry.create({
        data: {
          merchantId: batch.merchantId,
          type: 'credit_batch_payment',
          description: `Batch ödeme: ${batch.batchDate} — ${batch.merchantObj?.name || 'Merchant'}`,
          debit: 0,
          credit: batch.totalNet,
          balance: newBalance,
          relatedId: batch.id,
          batchId: batch.id,
        },
      });

      processedCount++;
    }

    res.json({ message: 'Batch ödemeleri tamamlandı', processedCount });
  } catch (err) {
    console.error('Run batch error:', err);
    res.status(500).json({ error: 'Batch çalıştırma başarısız' });
  }
});

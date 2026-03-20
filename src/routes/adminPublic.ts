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

// ── Commissions ──
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
        where: { merchantId: merchant.id, status: 'completed' },
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

    res.json(commissionsData);
  } catch (err) {
    console.error('Commissions error:', err);
    res.status(500).json({ error: 'Failed to load commissions', commissions: [] });
  }
});

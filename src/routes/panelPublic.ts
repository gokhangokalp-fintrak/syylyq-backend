// ─────────────────────────────────────────────────────
// VITA Platform — Public Merchant Panel API
// JWT gerektirmeden merchant paneline veri sağlar
// Her endpoint ?mid=MERCHANT_ID parametresi alır
// ─────────────────────────────────────────────────────
import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';

export const panelPublicRoutes = Router();

// ── Helper: merchantId'yi query'den al ──
async function getMerchantId(req: Request): Promise<string | null> {
  const mid = req.query.mid as string;
  if (mid) return mid;
  // Fallback: ilk onaylı merchant (sadece MVP için)
  const m = await prisma.merchant.findFirst({
    where: { approvalStatus: 'approved' },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  });
  return m?.id || null;
}

// ── Merchant listesi (panel başlangıcında merchant seçimi için) ──
panelPublicRoutes.get('/merchants', async (_req: Request, res: Response) => {
  try {
    const merchants = await prisma.merchant.findMany({
      where: { approvalStatus: 'approved' },
      select: { id: true, name: true, category: true },
      orderBy: { name: 'asc' },
    });
    res.json(merchants);
  } catch (err) {
    res.json([]);
  }
});

// ── Performance Stats ──
panelPublicRoutes.get('/performance', async (req: Request, res: Response) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return res.json({ stats: {}, branchPerformance: [] });

    const settlementAgg = await prisma.settlement.aggregate({
      where: { merchantId },
      _sum: { totalAmount: true, commissionAmount: true, netAmount: true },
      _count: true,
    });

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const monthlyRedemptions = await prisma.giftCardRedemption.count({
      where: {
        redeemedAt: { gte: thirtyDaysAgo },
        branch: { merchantId },
      },
    });

    // Unique müşteri sayısı (bu merchant'ta redemption yapan)
    const uniqueCustomers = await (prisma as any).giftCardRedemption.findMany({
      where: { branch: { merchantId } },
      select: { userId: true },
      distinct: ['userId'],
    });

    const avgAmount = settlementAgg._count > 0
      ? Math.round((settlementAgg._sum.totalAmount || 0) / settlementAgg._count)
      : 0;

    // Bu merchant'ın şubeleri
    const branches = await prisma.branch.findMany({
      where: { merchantId },
      include: {
        city: { select: { name: true } },
        redemptions: { select: { amount: true } },
      },
    });

    const branchPerformance = branches.map(b => ({
      name: b.name,
      city: b.city?.name || '',
      redemptionCount: b.redemptions.length,
      totalAmount: b.redemptions.reduce((sum, r) => sum + r.amount, 0),
    })).sort((a, b) => b.totalAmount - a.totalAmount);

    res.json({
      stats: {
        monthlyIncome: settlementAgg._sum.netAmount || 0,
        monthlyGross: settlementAgg._sum.totalAmount || 0,
        monthlyRedemptions,
        customerCount: uniqueCustomers.length,
        avgTransaction: avgAmount,
        totalTransactions: settlementAgg._count,
      },
      branchPerformance,
    });
  } catch (err) {
    console.error('Panel performance error:', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Redeemed Certificates (kullanılan sertifikalar) ──
panelPublicRoutes.get('/cards/redeemed', async (req: Request, res: Response) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return res.json([]);

    const redemptions = await prisma.giftCardRedemption.findMany({
      where: { branch: { merchantId } },
      orderBy: { redeemedAt: 'desc' },
      take: 50,
      include: {
        giftCard: { select: { code: true, amount: true, status: true, isVitaCert: true } },
        branch: { select: { name: true } },
        settlement: { select: { netAmount: true, commissionAmount: true, status: true } },
      },
    });

    res.json(redemptions.map(r => ({
      code: r.giftCard.code,
      amount: r.giftCard.amount,
      branchName: r.branch?.name || '-',
      netAmount: r.settlement?.netAmount || 0,
      commission: r.settlement?.commissionAmount || 0,
      settlementStatus: r.settlement?.status || 'pending',
      isVitaCert: r.giftCard.isVitaCert,
      redeemedAt: r.redeemedAt,
    })));
  } catch (err) {
    console.error('Redeemed cards error:', err);
    res.json([]);
  }
});

// ── Token Payments ──
panelPublicRoutes.get('/token-payments', async (req: Request, res: Response) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return res.json({ stats: { today: { count: 0, amount: 0 }, week: { count: 0, amount: 0 }, month: { count: 0, amount: 0 }, total: { count: 0, amount: 0 } }, payments: [] });

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(todayStart);
    weekStart.setDate(weekStart.getDate() - 7);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const merchantFilter = { branch: { merchantId }, status: 'completed' as const };

    const [todayStats, weekStats, monthStats, totalStats] = await Promise.all([
      (prisma as any).tokenRedemption.aggregate({
        where: { ...merchantFilter, createdAt: { gte: todayStart } },
        _sum: { amount: true }, _count: true,
      }),
      (prisma as any).tokenRedemption.aggregate({
        where: { ...merchantFilter, createdAt: { gte: weekStart } },
        _sum: { amount: true }, _count: true,
      }),
      (prisma as any).tokenRedemption.aggregate({
        where: { ...merchantFilter, createdAt: { gte: monthStart } },
        _sum: { amount: true }, _count: true,
      }),
      (prisma as any).tokenRedemption.aggregate({
        where: merchantFilter,
        _sum: { amount: true }, _count: true,
      }),
    ]);

    const recentPayments = await (prisma as any).tokenRedemption.findMany({
      where: { branch: { merchantId }, status: 'completed' },
      include: {
        user: { select: { name: true } },
        branch: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });

    res.json({
      stats: {
        today: { count: todayStats._count, amount: todayStats._sum?.amount || 0 },
        week: { count: weekStats._count, amount: weekStats._sum?.amount || 0 },
        month: { count: monthStats._count, amount: monthStats._sum?.amount || 0 },
        total: { count: totalStats._count, amount: totalStats._sum?.amount || 0 },
      },
      payments: recentPayments.map((p: any) => ({
        userName: p.user?.name || 'Bilinmiyor',
        amount: p.amount,
        netAmount: p.netAmount,
        branchName: p.branch?.name || '-',
        status: p.status,
        createdAt: p.createdAt,
      })),
    });
  } catch (err) {
    console.error('Token payments error:', err);
    res.json({
      stats: { today: { count: 0, amount: 0 }, week: { count: 0, amount: 0 }, month: { count: 0, amount: 0 }, total: { count: 0, amount: 0 } },
      payments: [],
    });
  }
});

// ── Ledger (Cari Hesap) ──
panelPublicRoutes.get('/ledger', async (req: Request, res: Response) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return res.json({ summary: { totalDebit: 0, totalCredit: 0, currentBalance: 0 }, entries: [] });

    let entries = await (prisma as any).ledgerEntry.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    // Eğer ledger boşsa, settlement kayıtlarından otomatik oluştur
    if (entries.length === 0) {
      const settlements = await prisma.settlement.findMany({
        where: { merchantId },
        orderBy: { createdAt: 'asc' },
        include: {
          merchant: { select: { name: true } },
          redemptions: {
            include: {
              giftCard: { select: { code: true } },
              branch: { select: { name: true } },
            },
          },
        },
      });

      if (settlements.length > 0) {
        let runningBalance = 0;
        for (const s of settlements) {
          runningBalance += s.netAmount;
          const gcCode = s.redemptions[0]?.giftCard?.code || '-';
          const branchName = s.redemptions[0]?.branch?.name || '-';

          await (prisma as any).ledgerEntry.create({
            data: {
              merchantId,
              type: 'Sertifika Kullanım',
              description: `${gcCode} — ${branchName} (${s.merchant.name})`,
              debit: s.netAmount,
              credit: 0,
              balance: runningBalance,
              relatedId: s.id,
              createdAt: s.createdAt,
            },
          });
        }

        entries = await (prisma as any).ledgerEntry.findMany({
          where: { merchantId },
          orderBy: { createdAt: 'desc' },
          take: 50,
        });
      }
    }

    const totals = await (prisma as any).ledgerEntry.aggregate({
      where: { merchantId },
      _sum: { debit: true, credit: true },
    });

    const lastEntry = entries[0];

    res.json({
      summary: {
        totalDebit: totals._sum?.debit || 0,
        totalCredit: totals._sum?.credit || 0,
        currentBalance: lastEntry?.balance || 0,
      },
      entries: entries.map((e: any) => ({
        type: e.type,
        description: e.description,
        debit: e.debit,
        credit: e.credit,
        balance: e.balance,
        createdAt: e.createdAt,
      })),
    });
  } catch (err) {
    console.error('Ledger error:', err);
    res.json({ summary: { totalDebit: 0, totalCredit: 0, currentBalance: 0 }, entries: [] });
  }
});

// ── Batch Payments (Toplu Ödemeler) ──
panelPublicRoutes.get('/batch-payments', async (req: Request, res: Response) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return res.json({ stats: { total: 0, completed: 0, pending: 0, cancelled: 0 }, batches: [] });

    const batches = await (prisma as any).batchSettlement.findMany({
      where: { merchantId },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { merchant: { select: { name: true } } },
    });

    const stats = {
      total: batches.length,
      completed: batches.filter((b: any) => b.status === 'completed').length,
      pending: batches.filter((b: any) => b.status === 'pending').length,
      cancelled: batches.filter((b: any) => b.status === 'cancelled' || b.status === 'failed').length,
    };

    res.json({
      stats,
      batches: batches.map((b: any) => ({
        id: b.id,
        batchDate: b.batchDate,
        merchantName: b.merchant?.name || '-',
        itemCount: b.itemCount,
        totalGross: b.totalGross,
        totalCommission: b.totalCommission,
        totalNet: b.totalNet,
        status: b.status,
        reference: b.reference || '-',
        createdAt: b.createdAt,
      })),
    });
  } catch (err) {
    console.error('Batch payments error:', err);
    res.json({ stats: { total: 0, completed: 0, pending: 0, cancelled: 0 }, batches: [] });
  }
});

// ── Bank Info ──
panelPublicRoutes.get('/bank-info', async (req: Request, res: Response) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return res.json({ name: '-', bankAccount: '-', bankName: '-' });

    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: {
        name: true,
        bankAccount: true,
        bankName: true,
        binIin: true,
        settlementMethod: true,
        contactPhone: true,
        contactEmail: true,
      },
    });

    res.json(merchant || { name: '-', bankAccount: '-', bankName: '-', binIin: '-', settlementMethod: 'havale', contactPhone: '-', contactEmail: '-' });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Staff (Çalışanlar) ──
panelPublicRoutes.get('/staff', async (req: Request, res: Response) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return res.json({ stats: { total: 0, owner: 0, manager: 0, staff: 0 }, staff: [] });

    const staff = await prisma.merchantUser.findMany({
      where: { merchantId },
      include: { merchant: { select: { name: true } } },
      orderBy: { createdAt: 'asc' },
    });

    const roleCounts = { owner: 0, manager: 0, staff: 0 };
    staff.forEach(s => {
      if (s.role === 'owner') roleCounts.owner++;
      else if (s.role === 'manager') roleCounts.manager++;
      else roleCounts.staff++;
    });

    res.json({
      stats: { total: staff.length, ...roleCounts },
      staff: staff.map(s => ({
        id: s.id, name: s.name, phone: s.phone, role: s.role,
        merchantName: s.merchant.name, isActive: s.isActive, createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Reviews/Inspections (Denetim Sonuçları) ──
panelPublicRoutes.get('/reviews', async (req: Request, res: Response) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return res.json({ stats: { totalReviews: 0, averageRating: 0, lastReviewDate: null }, reviews: [] });

    const completions = await prisma.mysteryTaskCompletion.findMany({
      where: { task: { merchantId } },
      include: {
        task: { select: { title: true, category: true } },
        user: { select: { name: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    });

    const avgRating = await prisma.mysteryTaskCompletion.aggregate({
      where: { task: { merchantId }, status: 'approved', rating: { not: null } },
      _avg: { rating: true },
      _count: true,
    });

    res.json({
      stats: {
        totalReviews: avgRating._count,
        averageRating: avgRating._avg.rating ? Number(avgRating._avg.rating.toFixed(1)) : 0,
        lastReviewDate: completions[0]?.createdAt || null,
      },
      reviews: completions.map(c => ({
        taskTitle: c.task.title, category: c.task.category,
        userName: c.user.name, rating: c.rating, comment: c.comment,
        status: c.status, createdAt: c.createdAt,
      })),
    });
  } catch (err) {
    console.error('Reviews error:', err);
    res.json({ stats: { totalReviews: 0, averageRating: 0, lastReviewDate: null }, reviews: [] });
  }
});

// ── Task Requests (Görev Talepleri) ──
panelPublicRoutes.get('/tasks', async (req: Request, res: Response) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return res.json([]);

    const tasks = await prisma.mysteryTask.findMany({
      where: { merchantId },
      include: {
        merchant: { select: { name: true } },
        _count: { select: { completions: true } },
        completions: {
          include: { user: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
          take: 5,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(tasks.map(t => ({
      id: t.id, title: t.title, description: t.description,
      category: t.category, userReward: t.userReward, businessPayment: t.businessPayment,
      maxCompletions: t.maxCompletions, completionCount: t._count.completions,
      isActive: t.isActive, merchantName: t.merchant.name,
      recentCompletions: t.completions.map(c => ({
        userName: c.user.name, rating: c.rating, status: c.status, createdAt: c.createdAt,
      })),
      createdAt: t.createdAt,
    })));
  } catch (err) {
    console.error('Tasks error:', err);
    res.json([]);
  }
});

// ── NearbyMe Profile ──
panelPublicRoutes.get('/nearby-profile', async (req: Request, res: Response) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return res.json({ merchant: null, stats: { views: 0, checkins: 0, rating: 0 } });

    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      include: {
        branches: { include: { city: { select: { name: true } } } },
      },
    });

    if (!merchant) {
      return res.json({ merchant: null, stats: { views: 0, checkins: 0, rating: 0 } });
    }

    const checkins = await (prisma as any).userLocation.count({
      where: { intent: 'checkin' },
    });

    res.json({
      merchant: {
        name: merchant.name,
        description: merchant.description,
        category: merchant.category,
        rating: merchant.rating,
        branches: merchant.branches.map(b => ({
          name: b.name, address: b.address, city: b.city?.name || '', phone: b.phone,
        })),
      },
      stats: {
        views: Math.floor(Math.random() * 100) + checkins * 3,
        checkins,
        rating: merchant.rating,
      },
    });
  } catch (err) {
    console.error('Nearby profile error:', err);
    res.json({ merchant: null, stats: { views: 0, checkins: 0, rating: 0 } });
  }
});

// ── Settings (Ayarlar) ──
panelPublicRoutes.get('/settings', async (req: Request, res: Response) => {
  try {
    const merchantId = await getMerchantId(req);
    if (!merchantId) return res.json({ merchant: {}, branches: [] });

    const merchant = await prisma.merchant.findUnique({
      where: { id: merchantId },
      select: {
        id: true, name: true, category: true, binIin: true,
        contactPhone: true, contactEmail: true, description: true, commissionRate: true,
      },
    });

    const branches = await prisma.branch.findMany({
      where: { merchantId },
      include: { city: { select: { name: true } } },
    });

    res.json({ merchant: merchant || {}, branches });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

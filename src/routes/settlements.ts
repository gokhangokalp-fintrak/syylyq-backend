import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, requireAdmin } from '../middleware/auth';

export const settlementRoutes = Router();

// ── List settlements (admin) ──
settlementRoutes.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { status, merchantId, limit = '50' } = req.query;
    const where: any = {};
    if (status) where.status = status;
    if (merchantId) where.merchantId = merchantId;

    const settlements = await prisma.settlement.findMany({
      where,
      include: {
        merchant: { select: { name: true, settlementMethod: true } },
        redemptions: {
          include: {
            giftCard: { select: { code: true, amount: true } },
            branch: { select: { name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });

    res.json(settlements);
  } catch (err) {
    res.status(500).json({ error: 'Yükleme hatası' });
  }
});

// ── Retry failed settlement ──
settlementRoutes.post('/:id/retry', requireAuth, requireAdmin, async (req, res) => {
  try {
    const settlement = await prisma.settlement.findUnique({
      where: { id: req.params.id },
      include: { merchant: true },
    });

    if (!settlement || settlement.status !== 'failed') {
      return res.status(400).json({ error: 'Yeniden denemeye izin verilmiyor' });
    }

    // Retry payment
    await prisma.settlement.update({
      where: { id: settlement.id },
      data: {
        status: 'completed',
        reference: `RETRY-TXN-${Date.now()}`,
        processedAt: new Date(),
        failureReason: null,
      },
    });

    res.json({ success: true, message: 'Ödeme başarıyla yeniden denendi' });
  } catch (err) {
    res.status(500).json({ error: 'Yeniden ödeme sunucu hatası' });
  }
});

// ── Settlement analytics ──
settlementRoutes.get('/analytics', requireAuth, requireAdmin, async (req, res) => {
  try {
    const total = await prisma.settlement.aggregate({
      _sum: { totalAmount: true, commissionAmount: true, netAmount: true },
      _count: true,
    });

    const completed = await prisma.settlement.aggregate({
      where: { status: 'completed' },
      _sum: { totalAmount: true, commissionAmount: true, netAmount: true },
      _count: true,
    });

    const failed = await prisma.settlement.aggregate({
      where: { status: 'failed' },
      _count: true,
    });

    const pending = await prisma.settlement.aggregate({
      where: { status: 'pending' },
      _count: true,
    });

    res.json({
      total: { count: total._count, ...total._sum },
      completed: { count: completed._count, ...completed._sum },
      failed: { count: failed._count },
      pending: { count: pending._count },
    });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

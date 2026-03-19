import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';

export const merchantRoutes = Router();

// ── List merchants (with optional city + category filter) ──
merchantRoutes.get('/', async (req, res) => {
  try {
    const { cityId, category, search, partnersOnly } = req.query;

    const where: any = {
      isActive: true,
      approvalStatus: 'approved',
    };

    if (category && category !== 'all') {
      where.category = category;
    }

    if (search) {
      where.name = { contains: search as string };
    }

    if (partnersOnly === 'true') {
      where.isPartner = true;
    }

    let merchants = await prisma.merchant.findMany({
      where,
      include: {
        branches: {
          where: cityId ? { cityId: cityId as string } : undefined,
          include: { city: true },
        },
        cardTemplates: {
          where: { isActive: true },
          orderBy: { denomination: 'asc' },
        },
        _count: {
          select: { giftCards: true },
        },
      },
      orderBy: [
        { isPartner: 'desc' },
        { rating: 'desc' },
      ],
    });

    // If cityId filter, only return merchants with branches in that city or nationwide
    if (cityId) {
      merchants = merchants.filter(m => m.isNationwide || m.branches.length > 0);
    }

    res.json(merchants);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'İş ortakları yükleme hatası' });
  }
});

// ── Get single merchant ──
merchantRoutes.get('/:id', async (req, res) => {
  try {
    const merchant = await prisma.merchant.findUnique({
      where: { id: req.params.id },
      include: {
        branches: { include: { city: true } },
        cardTemplates: {
          where: { isActive: true },
          orderBy: { denomination: 'asc' },
        },
      },
    });

    if (!merchant) {
      return res.status(404).json({ error: 'İş ortağı bulunamadı' });
    }

    res.json(merchant);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Get merchant branches by city ──
merchantRoutes.get('/:id/branches', async (req, res) => {
  try {
    const { cityId } = req.query;
    const branches = await prisma.branch.findMany({
      where: {
        merchantId: req.params.id,
        ...(cityId ? { cityId: cityId as string } : {}),
      },
      include: { city: true },
    });
    res.json(branches);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

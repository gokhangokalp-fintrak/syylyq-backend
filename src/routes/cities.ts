import { Router } from 'express';
import { prisma } from '../lib/prisma';

export const cityRoutes = Router();

// ── List all active cities ──
cityRoutes.get('/', async (_req, res) => {
  try {
    const cities = await prisma.city.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' },
      include: {
        _count: {
          select: { branches: true },
        },
      },
    });
    res.json(cities);
  } catch (err) {
    res.status(500).json({ error: 'Şehirler yükleme hatası' });
  }
});

// ── Get single city by ID ──
cityRoutes.get('/:id', async (req, res) => {
  try {
    const city = await prisma.city.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { branches: true } } },
    });
    if (!city) {
      return res.status(404).json({ error: 'Şehir bulunamadı' });
    }
    res.json(city);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Get city with merchants ──
cityRoutes.get('/:id/merchants', async (req, res) => {
  try {
    const { id } = req.params;
    const { category } = req.query;

    const where: any = {
      cityId: id,
      merchant: {
        isActive: true,
        approvalStatus: 'approved',
      },
    };

    if (category && category !== 'all') {
      where.merchant.category = category as string;
    }

    const branches = await prisma.branch.findMany({
      where,
      include: {
        merchant: {
          include: {
            cardTemplates: {
              where: { isActive: true },
              orderBy: { denomination: 'asc' },
            },
            _count: {
              select: { giftCards: true },
            },
          },
        },
      },
    });

    // Also include nationwide merchants
    const nationwideMerchants = await prisma.merchant.findMany({
      where: {
        isNationwide: true,
        isActive: true,
        approvalStatus: 'approved',
        ...(category && category !== 'all' ? { category: category as string } : {}),
      },
      include: {
        cardTemplates: {
          where: { isActive: true },
          orderBy: { denomination: 'asc' },
        },
        branches: {
          where: { cityId: id },
        },
        _count: {
          select: { giftCards: true },
        },
      },
    });

    // Merge and deduplicate
    const merchantMap = new Map<string, any>();

    for (const branch of branches) {
      if (!merchantMap.has(branch.merchant.id)) {
        merchantMap.set(branch.merchant.id, {
          ...branch.merchant,
          branches: [{ id: branch.id, name: branch.name, address: branch.address }],
        });
      } else {
        merchantMap.get(branch.merchant.id).branches.push({
          id: branch.id, name: branch.name, address: branch.address,
        });
      }
    }

    for (const m of nationwideMerchants) {
      if (!merchantMap.has(m.id)) {
        merchantMap.set(m.id, m);
      }
    }

    res.json(Array.from(merchantMap.values()));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'İş ortakları yükleme hatası' });
  }
});

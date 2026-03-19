import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMerchant } from '../middleware/auth';

export const mysteryTaskRoutes = Router();

// ══════════════════════════════════════════════════════
// TUYLU MÜŞTERİ — Mystery Shopper Task Payment Model
// İş modeli:
//   1. İşletme görev tanımlar ve VITA'ya öder (ör. 5000₸)
//   2. Kullanıcı görevi tamamlar
//   3. Kullanıcıya token verilir (ör. 4000 token)
//   4. VITA marjı kalır (ör. 1000₸)
// ══════════════════════════════════════════════════════

// ── List available tasks (user side) ──
mysteryTaskRoutes.get('/available', requireAuth, async (req, res) => {
  try {
    const { cityId, category } = req.query;
    const userId = req.auth!.id;

    const where: any = {
      isActive: true,
      OR: [
        { expiresAt: null },
        { expiresAt: { gt: new Date() } },
      ],
    };

    if (category) where.category = category;

    const tasks = await prisma.mysteryTask.findMany({
      where,
      include: {
        merchant: {
          select: { id: true, name: true, logoUrl: true, category: true },
          include: {
            branches: cityId ? {
              where: { cityId: cityId as string, isActive: true },
              select: { id: true, name: true, address: true },
            } : {
              where: { isActive: true },
              select: { id: true, name: true, address: true },
              take: 5,
            },
          },
        },
        completions: {
          where: { userId },
          select: { id: true, status: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Kullanıcının zaten tamamladığı görevleri işaretle
    const result = tasks.map((task: any) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      reward: task.userReward,
      category: task.category,
      merchant: task.merchant,
      branches: task.merchant.branches,
      maxCompletions: task.maxCompletions,
      completionCount: task.completionCount,
      isFull: task.completionCount >= task.maxCompletions,
      userCompleted: task.completions.length > 0,
      userCompletionStatus: task.completions[0]?.status || null,
      expiresAt: task.expiresAt,
    }));

    res.json(result);
  } catch (err) {
    console.error('Mystery tasks list error:', err);
    res.status(500).json({ error: 'Görev yükleme hatası' });
  }
});

// ── Submit task completion (user submits report) ──
mysteryTaskRoutes.post('/complete', requireAuth, async (req, res) => {
  try {
    const { taskId, rating, comment, photoUrl } = req.body;
    const userId = req.auth!.id;

    if (!taskId) {
      return res.status(400).json({ error: 'Görev ID zorunludur' });
    }

    const task = await prisma.mysteryTask.findUnique({
      where: { id: taskId },
      include: { merchant: true },
    });

    if (!task || !task.isActive) {
      return res.status(404).json({ error: 'Görev bulunamadı veya etkin değil' });
    }

    if (task.completionCount >= task.maxCompletions) {
      return res.status(400).json({ error: 'Tüm yerler dolu' });
    }

    // Kullanıcı bu görevi zaten tamamlamış mı?
    const existing = await prisma.mysteryTaskCompletion.findFirst({
      where: { taskId, userId },
    });

    if (existing) {
      return res.status(400).json({ error: 'Bu görevi zaten tamamladınız' });
    }

    // Completion oluştur
    const completion = await prisma.mysteryTaskCompletion.create({
      data: {
        taskId,
        userId,
        rating: rating || null,
        comment: comment || null,
        photoUrl: photoUrl || null,
        tokensAwarded: task.userReward,
        status: 'pending', // admin/merchant onayı bekliyor
      },
    });

    // Completion sayısını artır
    await prisma.mysteryTask.update({
      where: { id: taskId },
      data: { completionCount: { increment: 1 } },
    });

    res.json({
      success: true,
      completion: {
        id: completion.id,
        taskTitle: task.title,
        merchantName: task.merchant.name,
        tokensAwarded: task.userReward,
        status: 'pending',
        message: 'Raporunuz incelemeye gönderildi. Tokenler onaylandıktan sonra kredilendirilecek.',
      },
    });
  } catch (err) {
    console.error('Task completion error:', err);
    res.status(500).json({ error: 'Rapor gönderme hatası' });
  }
});

// ── Approve task completion (admin/merchant approves → tokens awarded) ──
mysteryTaskRoutes.post('/approve/:completionId', requireAuth, async (req, res) => {
  try {
    const { completionId } = req.params;
    const approvedBy = req.auth!.id;

    const completion = await prisma.mysteryTaskCompletion.findUnique({
      where: { id: completionId },
      include: {
        task: { include: { merchant: true } },
        user: true,
      },
    });

    if (!completion) {
      return res.status(404).json({ error: 'Rapor bulunamadı' });
    }

    if (completion.status !== 'pending') {
      return res.status(400).json({ error: `Rapor zaten işlendi (durum: ${completion.status})` });
    }

    // Yetki kontrol: admin veya merchant owner/manager
    const isAdmin = req.auth!.role === 'admin';
    const isMerchant = req.auth!.type === 'merchant' && req.auth!.merchantId === completion.task.merchantId;
    if (!isAdmin && !isMerchant) {
      return res.status(403).json({ error: 'Onay yapma izni yok' });
    }

    const tokensToAward = completion.tokensAwarded;

    // Completion onayla
    await prisma.mysteryTaskCompletion.update({
      where: { id: completionId },
      data: {
        status: 'approved',
        approvedBy,
        approvedAt: new Date(),
      },
    });

    // Kullanıcıya token ver
    await prisma.user.update({
      where: { id: completion.userId },
      data: { tokenBalance: { increment: tokensToAward } },
    });

    // Token transaction kaydı
    await prisma.tokenTransaction.create({
      data: {
        userId: completion.userId,
        amount: tokensToAward,
        type: 'earn_activity',
        source: `Gizli Müşteri: ${completion.task.merchant.name} — ${completion.task.title}`,
        isCashable: false,
        balanceAfter: completion.user.tokenBalance + tokensToAward,
        relatedId: completion.taskId,
      },
    });

    console.log(`🕵️ Mystery Task approved: +${tokensToAward} tokens for ${completion.user.name} (${completion.task.title})`);

    res.json({
      success: true,
      tokensAwarded: tokensToAward,
      userName: completion.user.name,
      taskTitle: completion.task.title,
    });
  } catch (err) {
    console.error('Task approve error:', err);
    res.status(500).json({ error: 'Onay hatası' });
  }
});

// ── Reject task completion ──
mysteryTaskRoutes.post('/reject/:completionId', requireAuth, async (req, res) => {
  try {
    const { completionId } = req.params;
    const { reason } = req.body;

    const completion = await prisma.mysteryTaskCompletion.findUnique({
      where: { id: completionId },
      include: { task: true },
    });

    if (!completion || completion.status !== 'pending') {
      return res.status(400).json({ error: 'Rapor bulunamadı veya zaten işlendi' });
    }

    await prisma.mysteryTaskCompletion.update({
      where: { id: completionId },
      data: { status: 'rejected' },
    });

    // Completion sayısını geri al (başka biri yapabilsin)
    await prisma.mysteryTask.update({
      where: { id: completion.taskId },
      data: { completionCount: { decrement: 1 } },
    });

    res.json({ success: true, reason: reason || 'Rapor kabul edilmedi' });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Create task (merchant side) ──
// İşletme görev tanımlar ve VITA'ya öder
mysteryTaskRoutes.post('/create', requireAuth, requireMerchant, async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId as string;
    const { title, description, businessPayment, category, maxCompletions, expiresAt } = req.body;

    if (!title || !businessPayment || businessPayment < 1000) {
      return res.status(400).json({ error: 'Ad ve ödeme zorunludur (min. 1000₸)' });
    }

    // VITA marjı: %20 (ör. 5000₸ → kullanıcı 4000 token, VITA 1000₸)
    const vitaMarginRate = 0.20;
    const vitaMargin = Math.round(businessPayment * vitaMarginRate);
    const userReward = businessPayment - vitaMargin;

    const task = await prisma.mysteryTask.create({
      data: {
        merchantId,
        title,
        description: description || null,
        businessPayment,
        userReward,
        vitaMargin,
        maxCompletions: maxCompletions || 1,
        category: category || 'service',
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
    });

    console.log(`🕵️ New mystery task: "${title}" by merchant ${merchantId} (${businessPayment}₸ → user ${userReward} tokens, VITA ${vitaMargin}₸)`);

    res.json({
      task: {
        id: task.id,
        title: task.title,
        businessPayment: task.businessPayment,
        userReward: task.userReward,
        vitaMargin: task.vitaMargin,
        maxCompletions: task.maxCompletions,
      },
    });
  } catch (err) {
    console.error('Task create error:', err);
    res.status(500).json({ error: 'Görev oluşturma hatası' });
  }
});

// ── List merchant's tasks ──
mysteryTaskRoutes.get('/merchant', requireAuth, requireMerchant, async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId;

    const tasks = await prisma.mysteryTask.findMany({
      where: { merchantId },
      include: {
        completions: {
          include: {
            user: { select: { name: true, phone: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── User's completed tasks ──
mysteryTaskRoutes.get('/my', requireAuth, async (req, res) => {
  try {
    const completions = await prisma.mysteryTaskCompletion.findMany({
      where: { userId: req.auth!.id },
      include: {
        task: {
          include: {
            merchant: { select: { name: true, logoUrl: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(completions);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

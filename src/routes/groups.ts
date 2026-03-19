// ─────────────────────────────────────────────────────
// VITA Platform — Group Gifts (Grupovoy Podaron)
// Arkadaşlarla birlikte toplu hediye sertifikası satın alma
// ─────────────────────────────────────────────────────

import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { createLogger } from '../utils/logger';
const log = createLogger('Groups');

export const groupRoutes = Router();

// Tüm endpoint'ler auth gerektirir
groupRoutes.use(requireAuth);

// ── Kullanıcının gruplarını listele ──
groupRoutes.get('/', async (req, res) => {
  try {
    const userId = req.auth!.id;

    const groups = await (prisma as any).groupGift.findMany({
      where: {
        OR: [
          { organizerId: userId },
          { participants: { some: { userId } } },
        ],
      },
      include: {
        participants: {
          orderBy: { createdAt: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ groups });
  } catch (err) {
    log.error('List error', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Grup detayı ──
groupRoutes.get('/:id', async (req, res) => {
  try {
    const userId = req.auth!.id;

    const group = await (prisma as any).groupGift.findUnique({
      where: { id: req.params.id },
      include: {
        participants: {
          orderBy: { createdAt: 'asc' },
        },
        organizer: {
          select: { id: true, name: true, avatarUrl: true },
        },
      },
    });

    if (!group) {
      return res.status(404).json({ error: 'Grup bulunamadı' });
    }

    // Kullanıcı bu grubun üyesi mi kontrol et
    const isMember =
      group.organizerId === userId ||
      group.participants.some((p: any) => p.userId === userId);

    if (!isMember) {
      return res.status(403).json({ error: 'Erişim yok' });
    }

    res.json({ group });
  } catch (err) {
    log.error('Detail error', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Yeni grup oluştur ──
groupRoutes.post('/', async (req, res) => {
  try {
    const userId = req.auth!.id;
    const {
      merchantId, merchantName, recipientName, recipientAvatar,
      recipientPhone, eventType, eventDate, targetAmount, participants,
    } = req.body;

    if (!recipientName || !eventType || !eventDate || !targetAmount) {
      return res.status(400).json({ error: 'Gerekli alanlar: recipientName, eventType, eventDate, targetAmount' });
    }

    if (targetAmount < 1000) {
      return res.status(400).json({ error: 'Minimum ₸1.000' });
    }

    // Organizatör bilgileri
    const organizer = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true },
    });

    // Transaction ile grup + katılımcıları oluştur
    const group = await (prisma as any).groupGift.create({
      data: {
        organizerId: userId,
        merchantId: merchantId || null,
        merchantName: merchantName || 'VITA Sertifika',
        recipientName,
        recipientAvatar: recipientAvatar || recipientName.charAt(0).toUpperCase(),
        recipientPhone: recipientPhone || null,
        eventType,
        eventDate: new Date(eventDate),
        targetAmount,
        collectedAmount: 0,
        participants: {
          create: [
            // Organizatör her zaman ilk katılımcıdır
            {
              userId,
              name: organizer?.name || 'Düzenleyici',
              avatar: (organizer?.name || 'O').charAt(0).toUpperCase(),
              color: '#7C3AED',
              amount: Math.floor(targetAmount / (1 + (participants?.length || 0))),
              isOrganizer: true,
            },
            // Diğer katılımcılar
            ...(participants || []).map((p: any) => ({
              userId: p.userId || null,
              name: p.name,
              avatar: p.avatar || (p.name || 'A').charAt(0).toUpperCase(),
              color: p.color || '#6366F1',
              amount: Math.floor(targetAmount / (1 + (participants?.length || 0))),
              isOrganizer: false,
            })),
          ],
        },
      },
      include: {
        participants: true,
      },
    });

    // Katılımcılara bildirim gönder
    const participantUserIds = (participants || [])
      .filter((p: any) => p.userId)
      .map((p: any) => p.userId);

    if (participantUserIds.length > 0) {
      await (prisma as any).notification.createMany({
        data: participantUserIds.map((uid: string) => ({
          userId: uid,
          type: 'system',
          title: '👥 Grup hediye',
          body: `${organizer?.name || 'Kullanıcı'} sizi hediye grubu için davet etti ${recipientName}`,
          icon: '👥',
          actionType: 'navigate',
          actionTarget: `/group-detail?groupId=${group.id}`,
          relatedId: group.id,
        })),
      });
    }

    res.json({ success: true, group });
  } catch (err) {
    log.error('Create error', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Gruba katılımcı ekle ──
groupRoutes.post('/:id/participants', async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { name, avatar, color, userIdToAdd } = req.body;

    const group = await (prisma as any).groupGift.findUnique({
      where: { id: req.params.id },
      include: { participants: true },
    });

    if (!group) {
      return res.status(404).json({ error: 'Grup bulunamadı' });
    }

    if (group.organizerId !== userId) {
      return res.status(403).json({ error: 'Sadece organizatör katılımcı ekleyebilir' });
    }

    if (group.status !== 'collecting') {
      return res.status(400).json({ error: 'Toplama zaten tamamlandı' });
    }

    // Yeni katılımcı ile birlikte eşit bölüşüm yeniden hesapla
    const newCount = group.participants.length + 1;
    const newPerPerson = Math.floor(group.targetAmount / newCount);

    // Mevcut katılımcıların tutarlarını güncelle
    for (const p of group.participants) {
      await (prisma as any).groupParticipant.update({
        where: { id: p.id },
        data: { amount: newPerPerson },
      });
    }

    // Yeni katılımcıyı ekle
    const participant = await (prisma as any).groupParticipant.create({
      data: {
        groupId: req.params.id,
        userId: userIdToAdd || null,
        name: name || 'Katılımcı',
        avatar: avatar || (name || 'K').charAt(0).toUpperCase(),
        color: color || '#6366F1',
        amount: newPerPerson,
        isOrganizer: false,
      },
    });

    // Bildirim
    if (userIdToAdd) {
      const organizer = await prisma.user.findUnique({
        where: { id: userId }, select: { name: true },
      });
      await (prisma as any).notification.create({
        data: {
          userId: userIdToAdd,
          type: 'system',
          title: '👥 Gruba eklemediniz',
          body: `${organizer?.name || 'Düzenleyici'} sizi hediye grubu için ekledi ${group.recipientName}`,
          icon: '👥',
          actionType: 'navigate',
          actionTarget: `/group-detail?groupId=${group.id}`,
          relatedId: group.id,
        },
      });
    }

    // Güncel grubu döndür
    const updatedGroup = await (prisma as any).groupGift.findUnique({
      where: { id: req.params.id },
      include: { participants: { orderBy: { createdAt: 'asc' } } },
    });

    res.json({ success: true, group: updatedGroup });
  } catch (err) {
    log.error('Add participant error', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Katılımcı ödemesini işaretle (mock — PSP entegrasyonu sonra) ──
groupRoutes.post('/:id/pay', async (req, res) => {
  try {
    const userId = req.auth!.id;

    const group = await (prisma as any).groupGift.findUnique({
      where: { id: req.params.id },
      include: { participants: true },
    });

    if (!group) {
      return res.status(404).json({ error: 'Grup bulunamadı' });
    }

    // Bu kullanıcının katılımcısını bul
    const participant = group.participants.find(
      (p: any) => p.userId === userId
    );

    if (!participant) {
      return res.status(403).json({ error: 'Bu grubun üyesi değilsiniz' });
    }

    if (participant.paid) {
      return res.status(400).json({ error: 'Zaten kendi payınızı ödediniz' });
    }

    // Ödemeyi işaretle
    await (prisma as any).groupParticipant.update({
      where: { id: participant.id },
      data: { paid: true, paidAt: new Date() },
    });

    // Toplanan tutarı güncelle
    const newCollected = group.collectedAmount + participant.amount;
    const updateData: any = { collectedAmount: newCollected };

    // Hedef karşılandı mı?
    if (newCollected >= group.targetAmount) {
      updateData.status = 'completed';

      // Organizatöre bildirim
      await (prisma as any).notification.create({
        data: {
          userId: group.organizerId,
          type: 'system',
          title: '🎉 Toplama tamamlandı!',
          body: `Tüm katılımcılar hediye için kendi paylarını ödedi ${group.recipientName}!`,
          icon: '🎉',
          actionType: 'navigate',
          actionTarget: `/group-detail?groupId=${group.id}`,
          relatedId: group.id,
        },
      });
    }

    await (prisma as any).groupGift.update({
      where: { id: req.params.id },
      data: updateData,
    });

    // Güncel grubu döndür
    const updatedGroup = await (prisma as any).groupGift.findUnique({
      where: { id: req.params.id },
      include: { participants: { orderBy: { createdAt: 'asc' } } },
    });

    res.json({ success: true, group: updatedGroup });
  } catch (err) {
    log.error('Pay error', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Hatırlatma gönder (organizatör) ──
groupRoutes.post('/:id/remind', async (req, res) => {
  try {
    const userId = req.auth!.id;

    const group = await (prisma as any).groupGift.findUnique({
      where: { id: req.params.id },
      include: { participants: true },
    });

    if (!group || group.organizerId !== userId) {
      return res.status(403).json({ error: 'Sadece organizatör' });
    }

    const organizer = await prisma.user.findUnique({
      where: { id: userId }, select: { name: true },
    });

    // Ödeme yapmamış katılımcılara bildirim
    const unpaid = group.participants.filter(
      (p: any) => !p.paid && p.userId && p.userId !== userId
    );

    if (unpaid.length === 0) {
      return res.json({ success: true, reminded: 0 });
    }

    await (prisma as any).notification.createMany({
      data: unpaid.map((p: any) => ({
        userId: p.userId,
        type: 'system',
        title: '📩 Ödeme hatırlatması',
        body: `${organizer?.name || 'Düzenleyici'} hatırlatıyor: kendi payınızı ödeyin (${p.amount.toLocaleString('tr-TR')}₸) hediye için ${group.recipientName}`,
        icon: '📩',
        actionType: 'navigate',
        actionTarget: `/group-detail?groupId=${group.id}`,
        relatedId: group.id,
      })),
    });

    res.json({ success: true, reminded: unpaid.length });
  } catch (err) {
    log.error('Remind error', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Grubu iptal et (organizatör) ──
groupRoutes.delete('/:id', async (req, res) => {
  try {
    const userId = req.auth!.id;

    const group = await (prisma as any).groupGift.findUnique({
      where: { id: req.params.id },
    });

    if (!group || group.organizerId !== userId) {
      return res.status(403).json({ error: 'Sadece organizatör grubu iptal edebilir' });
    }

    if (group.status === 'completed' || group.status === 'sent') {
      return res.status(400).json({ error: 'Tamamlanan toplamanın iptal edilmesi izin verilmiyor' });
    }

    await (prisma as any).groupGift.update({
      where: { id: req.params.id },
      data: { status: 'cancelled' },
    });

    res.json({ success: true });
  } catch (err) {
    log.error('Cancel error', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

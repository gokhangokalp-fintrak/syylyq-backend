// ─────────────────────────────────────────────────────
// VITA Platform — User Connections (Arkadaşlık Sistemi)
// Kullanıcılar arası bağlantı: doğum günü hatırlatması,
// hediye önerileri vb. için temel
// ─────────────────────────────────────────────────────

import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { validate, connectionRequestSchema } from '../middleware/validate';
import { createLogger } from '../utils/logger';
const log = createLogger('Connections');

export const connectionRoutes = Router();

// Tüm endpoint'ler auth gerektirir
connectionRoutes.use(requireAuth);

// ── Bağlantılarımı listele ──
connectionRoutes.get('/', async (req, res) => {
  try {
    const userId = req.auth!.id;

    const connections = await (prisma as any).userConnection.findMany({
      where: {
        OR: [
          { fromUserId: userId, status: 'accepted' },
          { toUserId: userId, status: 'accepted' },
        ],
      },
      include: {
        fromUser: { select: { id: true, name: true, avatarUrl: true, birthday: true } },
        toUser: { select: { id: true, name: true, avatarUrl: true, birthday: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Karşı tarafın bilgilerini döndür
    const friends = connections.map((c: any) => {
      const friend = c.fromUserId === userId ? c.toUser : c.fromUser;
      return {
        connectionId: c.id,
        friend: {
          id: friend.id,
          name: friend.name,
          avatarUrl: friend.avatarUrl,
          birthday: friend.birthday,
        },
        nickname: c.nickname,
        connectedAt: c.acceptedAt || c.createdAt,
      };
    });

    res.json({ friends });
  } catch (err) {
    log.error('List error', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Bekleyen bağlantı istekleri ──
connectionRoutes.get('/pending', async (req, res) => {
  try {
    const userId = req.auth!.id;

    const pending = await (prisma as any).userConnection.findMany({
      where: { toUserId: userId, status: 'pending' },
      include: {
        fromUser: { select: { id: true, name: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({ pending });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Bağlantı isteği gönder (telefon numarasıyla) ──
connectionRoutes.post('/request', validate(connectionRequestSchema), async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { phone, nickname } = req.body;

    if (!phone) {
      return res.status(400).json({ error: 'Telefon zorunludur' });
    }

    // Kendine istek gönderemez
    const self = await prisma.user.findUnique({ where: { id: userId } });
    if (self?.phone === phone) {
      return res.status(400).json({ error: 'Kendinizi eklemeye izin verilmiyor' });
    }

    // Hedef kullanıcıyı bul
    const targetUser = await prisma.user.findUnique({ where: { phone } });
    if (!targetUser) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }

    // Zaten bağlantı var mı?
    const existing = await (prisma as any).userConnection.findFirst({
      where: {
        OR: [
          { fromUserId: userId, toUserId: targetUser.id },
          { fromUserId: targetUser.id, toUserId: userId },
        ],
      },
    });

    if (existing) {
      if (existing.status === 'accepted') {
        return res.status(400).json({ error: 'Zaten arkadaşsınız' });
      }
      if (existing.status === 'pending') {
        return res.status(400).json({ error: 'İstek zaten gönderildi' });
      }
    }

    const connection = await (prisma as any).userConnection.create({
      data: {
        fromUserId: userId,
        toUserId: targetUser.id,
        nickname: nickname || null,
      },
    });

    // Bildirim gönder
    await (prisma as any).notification.create({
      data: {
        userId: targetUser.id,
        type: 'system',
        title: '👋 Arkadaş isteği',
        body: `${self?.name || 'Kullanıcı'} sizi arkadaş olarak eklemek istiyor`,
        icon: '👋',
        actionType: 'navigate',
        actionTarget: '/connections',
        relatedId: connection.id,
      },
    });

    res.json({ success: true, connection });
  } catch (err) {
    log.error('Request error', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Bağlantı isteğini kabul et ──
connectionRoutes.post('/:id/accept', async (req, res) => {
  try {
    const userId = req.auth!.id;

    const connection = await (prisma as any).userConnection.findUnique({
      where: { id: req.params.id },
    });

    if (!connection || connection.toUserId !== userId) {
      return res.status(404).json({ error: 'İstek bulunamadı' });
    }

    await (prisma as any).userConnection.update({
      where: { id: req.params.id },
      data: { status: 'accepted', acceptedAt: new Date() },
    });

    // Karşı tarafa bildirim
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    await (prisma as any).notification.create({
      data: {
        userId: connection.fromUserId,
        type: 'system',
        title: '🤝 Arkadaş eklendi!',
        body: `${user?.name || 'Kullanıcı'} arkadaş isteğinizi kabul etti`,
        icon: '🤝',
      },
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Bağlantıyı sil ──
connectionRoutes.delete('/:id', async (req, res) => {
  try {
    const userId = req.auth!.id;

    const connection = await (prisma as any).userConnection.findUnique({
      where: { id: req.params.id },
    });

    if (!connection || (connection.fromUserId !== userId && connection.toUserId !== userId)) {
      return res.status(404).json({ error: 'Bulunamadı' });
    }

    await (prisma as any).userConnection.delete({ where: { id: req.params.id } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

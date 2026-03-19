// ─────────────────────────────────────────────────────
// VITA Platform — Notification Routes
// Genel bildirim sistemi — tüm bildirim türlerini destekler
// ─────────────────────────────────────────────────────

import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { validate, notificationSendSchema, notificationBroadcastSchema } from '../middleware/validate';
import { createLogger } from '../utils/logger';
const log = createLogger('Notifications');

export const notificationRoutes = Router();

// ══════════════════════════════════════════════════════
// USER ENDPOINTS
// ══════════════════════════════════════════════════════

// ── Kullanıcının bildirimlerini listele ──
notificationRoutes.get('/', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { limit = '50', unreadOnly } = req.query;

    const where: any = { userId };
    if (unreadOnly === 'true') where.isRead = false;

    const notifications = await (prisma as any).notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });

    const unreadCount = await (prisma as any).notification.count({
      where: { userId, isRead: false },
    });

    res.json({ notifications, unreadCount });
  } catch (err) {
    log.error('List error', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Okunmamış bildirim sayısı ──
notificationRoutes.get('/unread-count', requireAuth, async (req, res) => {
  try {
    const count = await (prisma as any).notification.count({
      where: { userId: req.auth!.id, isRead: false },
    });
    res.json({ unreadCount: count });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Bildirimi okundu olarak işaretle ──
notificationRoutes.post('/:id/read', requireAuth, async (req, res) => {
  try {
    const notification = await (prisma as any).notification.updateMany({
      where: { id: req.params.id, userId: req.auth!.id },
      data: { isRead: true, readAt: new Date() },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Tüm bildirimleri okundu olarak işaretle ──
notificationRoutes.post('/read-all', requireAuth, async (req, res) => {
  try {
    await (prisma as any).notification.updateMany({
      where: { userId: req.auth!.id, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ══════════════════════════════════════════════════════
// ADMIN ENDPOINTS — Bildirim gönderme
// ══════════════════════════════════════════════════════

// ── Tek kullanıcıya bildirim gönder ──
notificationRoutes.post('/send', requireAuth, requireAdmin, validate(notificationSendSchema), async (req, res) => {
  try {
    const { userId, type, title, body, icon, actionType, actionTarget, relatedId } = req.body;

    if (!userId || !title || !body) {
      return res.status(400).json({ error: 'userId, title ve body zorunlu' });
    }

    const notification = await (prisma as any).notification.create({
      data: {
        userId,
        type: type || 'system',
        title,
        body,
        icon: icon || null,
        actionType: actionType || null,
        actionTarget: actionTarget || null,
        relatedId: relatedId || null,
      },
    });

    res.json({ success: true, notification });
  } catch (err) {
    log.error('Send error', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Tüm kullanıcılara toplu bildirim gönder (broadcast) ──
notificationRoutes.post('/broadcast', requireAuth, requireAdmin, validate(notificationBroadcastSchema), async (req, res) => {
  try {
    const { type, title, body, icon, actionType, actionTarget } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: 'title ve body zorunlu' });
    }

    const users = await prisma.user.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    const notifications = await (prisma as any).notification.createMany({
      data: users.map(u => ({
        userId: u.id,
        type: type || 'promo',
        title,
        body,
        icon: icon || null,
        actionType: actionType || null,
        actionTarget: actionTarget || null,
      })),
    });

    res.json({ success: true, sentTo: users.length });
  } catch (err) {
    log.error('Broadcast error', err);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ══════════════════════════════════════════════════════
// HELPER: Programmatic notification creation
// Diğer route'lardan çağrılabilir
// ══════════════════════════════════════════════════════

export async function createNotification(data: {
  userId: string;
  type: string;
  title: string;
  body: string;
  icon?: string;
  actionType?: string;
  actionTarget?: string;
  relatedId?: string;
}) {
  try {
    return await (prisma as any).notification.create({ data });
  } catch (err) {
    log.error('Create error', err);
    return null;
  }
}

// Toplu bildirim (birden fazla kullanıcıya aynı anda)
export async function createBulkNotifications(userIds: string[], data: {
  type: string;
  title: string;
  body: string;
  icon?: string;
  actionType?: string;
  actionTarget?: string;
  relatedId?: string;
}) {
  try {
    return await (prisma as any).notification.createMany({
      data: userIds.map(userId => ({ userId, ...data })),
    });
  } catch (err) {
    log.error('Bulk create error', err);
    return null;
  }
}

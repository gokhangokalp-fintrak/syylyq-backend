// ─────────────────────────────────────────────────────
// VITA Platform — NearbyMe (Location-based Discovery)
// Real-time location sharing + friend discovery + chat
// ─────────────────────────────────────────────────────

import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { createLogger } from '../utils/logger';

const log = createLogger('NearbyMe');

export const nearbyRoutes = Router();

// Haversine formula — calculate distance between two points in meters
function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // Earth radius in meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// All endpoints require authentication
nearbyRoutes.use(requireAuth);

// ─────────────────────────────────────────────────────
// CHECK-IN: Update user location + intent
// ─────────────────────────────────────────────────────
nearbyRoutes.post('/checkin', async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { latitude, longitude, intent, venueId } = req.body;

    if (latitude === undefined || longitude === undefined) {
      return res.status(400).json({ error: 'Konum bilgisi gereklidir' });
    }

    // Validate coordinates
    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
      return res.status(400).json({ error: 'Geçersiz konum koordinatları' });
    }

    // Upsert UserLocation
    const location = await (prisma as any).userLocation.upsert({
      where: { userId },
      update: {
        latitude,
        longitude,
        intent: intent || null,
        venueId: venueId || null,
        isActive: true,
        updatedAt: new Date(),
      },
      create: {
        userId,
        latitude,
        longitude,
        intent: intent || null,
        venueId: venueId || null,
        isActive: true,
      },
    });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    log.info(`Check-in: ${user?.name} at (${latitude}, ${longitude})`);

    res.json({
      success: true,
      location: {
        id: location.id,
        latitude: location.latitude,
        longitude: location.longitude,
        intent: location.intent,
        venueId: location.venueId,
        isActive: location.isActive,
      },
    });
  } catch (err) {
    log.error('Check-in error', err);
    res.status(500).json({ error: 'Check-in başarısız' });
  }
});

// ─────────────────────────────────────────────────────
// CHECK-OUT: Set user inactive
// ─────────────────────────────────────────────────────
nearbyRoutes.post('/checkout', async (req, res) => {
  try {
    const userId = req.auth!.id;

    const location = await (prisma as any).userLocation.update({
      where: { userId },
      data: { isActive: false, updatedAt: new Date() },
    });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    log.info(`Check-out: ${user?.name}`);

    res.json({ success: true, location });
  } catch (err) {
    log.error('Check-out error', err);
    res.status(500).json({ error: 'Check-out başarısız' });
  }
});

// ─────────────────────────────────────────────────────
// DISCOVER: Find nearby active users
// Query: intent (optional), radius (default 500m)
// ─────────────────────────────────────────────────────
nearbyRoutes.get('/discover', async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { intent, radius = '500' } = req.query;
    const radiusMeters = parseInt(radius as string) || 500;

    // Get current user's location
    const userLocation = await (prisma as any).userLocation.findUnique({
      where: { userId },
    });

    if (!userLocation) {
      return res.status(400).json({ error: 'Önce check-in yapmalısınız' });
    }

    if (!userLocation.isActive) {
      return res.status(400).json({ error: 'Kullanıcı şu anda aktif değildir' });
    }

    // Get all active locations
    const allLocations = await (prisma as any).userLocation.findMany({
      where: {
        isActive: true,
        userId: { not: userId }, // Exclude self
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
            tokenBalance: true,
          },
        },
      },
    });

    // Filter by distance + optional intent
    const nearby = allLocations
      .map((loc: any) => {
        const distance = haversineDistance(
          userLocation.latitude,
          userLocation.longitude,
          loc.latitude,
          loc.longitude
        );

        return {
          ...loc,
          distance,
          user: {
            ...loc.user,
            displayName: loc.user.name,
            avatarInitial: loc.user.name.charAt(0).toUpperCase(),
          },
        };
      })
      .filter(
        (loc: any) =>
          loc.distance <= radiusMeters &&
          (!intent || loc.intent === intent)
      )
      .sort((a: any, b: any) => a.distance - b.distance)
      .map((loc: any) => ({
        id: loc.user.id,
        displayName: loc.user.displayName,
        avatarInitial: loc.user.avatarInitial,
        bio: loc.user.bio || null,
        intent: loc.intent,
        distance: Math.round(loc.distance),
        isActive: loc.isActive,
      }));

    res.json({ nearby, count: nearby.length, radiusMeters });
  } catch (err) {
    log.error('Discover error', err);
    res.status(500).json({ error: 'Keşif başarısız' });
  }
});

// ─────────────────────────────────────────────────────
// CONNECT: Send connection request (initiates NearbyMatch)
// Body: { targetUserId }
// ─────────────────────────────────────────────────────
nearbyRoutes.post('/connect', async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { targetUserId } = req.body;

    if (!targetUserId) {
      return res.status(400).json({ error: 'Hedef kullanıcı gereklidir' });
    }

    if (userId === targetUserId) {
      return res.status(400).json({ error: 'Kendinize istek gönderemezsiniz' });
    }

    // Verify target user exists
    const targetUser = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!targetUser) {
      return res.status(404).json({ error: 'Hedef kullanıcı bulunamadı' });
    }

    // Check for existing match (either direction)
    const existing = await (prisma as any).nearbyMatch.findFirst({
      where: {
        OR: [
          { user1Id: userId, user2Id: targetUserId },
          { user1Id: targetUserId, user2Id: userId },
        ],
      },
    });

    if (existing) {
      if (existing.status !== 'rejected') {
        return res.status(400).json({ error: 'Bu kullanıcıyla zaten bir bağlantısınız var' });
      }
      // Allow re-requesting if previous was rejected
    }

    // Create NearbyMatch
    const match = await (prisma as any).nearbyMatch.create({
      data: {
        user1Id: userId,
        user2Id: targetUserId,
        initiatorId: userId,
        status: 'pending',
      },
    });

    // Send notification to target
    const currentUser = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    await (prisma as any).notification.create({
      data: {
        userId: targetUserId,
        type: 'system',
        title: '👋 Yakında Biri Seni Buldu!',
        body: `${currentUser?.name || 'Birisi'} seni yakında buluyor. İsteklerini gör!`,
        icon: '👋',
        actionType: 'navigate',
        actionTarget: '/nearby/requests',
        relatedId: match.id,
      },
    });

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    log.info(`Connection request: ${user?.name} → ${targetUser.name}`);

    res.json({ success: true, match: { id: match.id, status: match.status } });
  } catch (err) {
    log.error('Connect error', err);
    res.status(500).json({ error: 'Bağlantı başarısız' });
  }
});

// ─────────────────────────────────────────────────────
// GET REQUESTS: Pending incoming requests
// ─────────────────────────────────────────────────────
nearbyRoutes.get('/requests', async (req, res) => {
  try {
    const userId = req.auth!.id;

    const requests = await (prisma as any).nearbyMatch.findMany({
      where: {
        user2Id: userId,
        status: 'pending',
      },
      include: {
        user1: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const formatted = requests.map((req: any) => ({
      matchId: req.id,
      requester: {
        id: req.user1.id,
        displayName: req.user1.name,
        avatarInitial: req.user1.name.charAt(0).toUpperCase(),
      },
      sentAt: req.createdAt,
    }));

    res.json({ requests: formatted, count: formatted.length });
  } catch (err) {
    log.error('Get requests error', err);
    res.status(500).json({ error: 'İstekler yüklenemedi' });
  }
});

// ─────────────────────────────────────────────────────
// ACCEPT: Accept a connection request
// ─────────────────────────────────────────────────────
nearbyRoutes.put('/connect/:matchId/accept', async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { matchId } = req.params;

    const match = await (prisma as any).nearbyMatch.findUnique({
      where: { id: matchId },
    });

    if (!match) {
      return res.status(404).json({ error: 'Bağlantı bulunamadı' });
    }

    if (match.user2Id !== userId) {
      return res.status(403).json({ error: 'Bu isteği kabul etme yetkiniz yok' });
    }

    if (match.status !== 'pending') {
      return res.status(400).json({ error: 'Bu istek artık geçerli değil' });
    }

    const updated = await (prisma as any).nearbyMatch.update({
      where: { id: matchId },
      data: { status: 'accepted', updatedAt: new Date() },
    });

    // Notify initiator
    const accepter = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    await (prisma as any).notification.create({
      data: {
        userId: match.initiatorId,
        type: 'system',
        title: '🎉 Bağlantı Kabul Edildi!',
        body: `${accepter?.name || 'Birisi'} seni yakında bulmak istedi. Sohbete başla!`,
        icon: '🎉',
        actionType: 'navigate',
        actionTarget: `/nearby/chat/${matchId}`,
        relatedId: matchId,
      },
    });

    log.info(`Connection accepted: match ${matchId}`);

    res.json({ success: true, match: { id: updated.id, status: updated.status } });
  } catch (err) {
    log.error('Accept error', err);
    res.status(500).json({ error: 'Kabul başarısız' });
  }
});

// ─────────────────────────────────────────────────────
// DELETE/REJECT: Reject or delete a match
// ─────────────────────────────────────────────────────
nearbyRoutes.delete('/connect/:matchId', async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { matchId } = req.params;

    const match = await (prisma as any).nearbyMatch.findUnique({
      where: { id: matchId },
    });

    if (!match) {
      return res.status(404).json({ error: 'Bağlantı bulunamadı' });
    }

    // User must be one of the participants
    if (match.user1Id !== userId && match.user2Id !== userId) {
      return res.status(403).json({ error: 'Bu işlemi yapma yetkiniz yok' });
    }

    // If pending, mark as rejected; if accepted, can be deleted
    const result = match.status === 'pending'
      ? await (prisma as any).nearbyMatch.update({
          where: { id: matchId },
          data: { status: 'rejected' },
        })
      : await (prisma as any).nearbyMatch.delete({
          where: { id: matchId },
        });

    log.info(`Match ${matchId} rejected/deleted`);

    res.json({ success: true });
  } catch (err) {
    log.error('Delete/reject error', err);
    res.status(500).json({ error: 'İşlem başarısız' });
  }
});

// ─────────────────────────────────────────────────────
// GET MATCHES: List accepted matches (conversations)
// ─────────────────────────────────────────────────────
nearbyRoutes.get('/matches', async (req, res) => {
  try {
    const userId = req.auth!.id;

    const matches = await (prisma as any).nearbyMatch.findMany({
      where: {
        status: 'accepted',
        OR: [
          { user1Id: userId },
          { user2Id: userId },
        ],
      },
      include: {
        user1: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
        user2: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
        messages: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const formatted = matches.map((m: any) => {
      const otherUser = m.user1Id === userId ? m.user2 : m.user1;
      const lastMessage = m.messages[0] || null;

      return {
        matchId: m.id,
        otherUser: {
          id: otherUser.id,
          displayName: otherUser.name,
          avatarInitial: otherUser.name.charAt(0).toUpperCase(),
        },
        lastMessage: lastMessage ? {
          text: lastMessage.text,
          sentAt: lastMessage.createdAt,
          isFromMe: lastMessage.senderId === userId,
        } : null,
        connectedAt: m.createdAt,
      };
    });

    res.json({ matches: formatted, count: formatted.length });
  } catch (err) {
    log.error('Get matches error', err);
    res.status(500).json({ error: 'Eşleşmeler yüklenemedi' });
  }
});

// ─────────────────────────────────────────────────────
// GET CHAT: Fetch messages for a match
// ─────────────────────────────────────────────────────
nearbyRoutes.get('/chat/:matchId', async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { matchId } = req.params;

    const match = await (prisma as any).nearbyMatch.findUnique({
      where: { id: matchId },
    });

    if (!match) {
      return res.status(404).json({ error: 'Sohbet bulunamadı' });
    }

    if (match.user1Id !== userId && match.user2Id !== userId) {
      return res.status(403).json({ error: 'Bu sohbete erişim yetkiniz yok' });
    }

    const messages = await (prisma as any).nearbyMessage.findMany({
      where: { matchId },
      include: {
        sender: {
          select: {
            id: true,
            name: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    // Mark unread messages as read
    await (prisma as any).nearbyMessage.updateMany({
      where: {
        matchId,
        senderId: { not: userId },
        read: false,
      },
      data: { read: true },
    });

    const formatted = messages.map((msg: any) => ({
      id: msg.id,
      text: msg.text,
      senderId: msg.sender.id,
      senderName: msg.sender.name,
      isFromMe: msg.sender.id === userId,
      sentAt: msg.createdAt,
      read: msg.read,
    }));

    res.json({ messages: formatted });
  } catch (err) {
    log.error('Get chat error', err);
    res.status(500).json({ error: 'Mesajlar yüklenemedi' });
  }
});

// ─────────────────────────────────────────────────────
// SEND MESSAGE: Post a message to a match
// Body: { text }
// ─────────────────────────────────────────────────────
nearbyRoutes.post('/chat/:matchId', async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { matchId } = req.params;
    const { text } = req.body;

    if (!text || text.trim() === '') {
      return res.status(400).json({ error: 'Mesaj metni gereklidir' });
    }

    const match = await (prisma as any).nearbyMatch.findUnique({
      where: { id: matchId },
    });

    if (!match) {
      return res.status(404).json({ error: 'Sohbet bulunamadı' });
    }

    if (match.user1Id !== userId && match.user2Id !== userId) {
      return res.status(403).json({ error: 'Bu sohbete erişim yetkiniz yok' });
    }

    if (match.status !== 'accepted') {
      return res.status(400).json({ error: 'Bu sohbet henüz aktif değil' });
    }

    const message = await (prisma as any).nearbyMessage.create({
      data: {
        matchId,
        senderId: userId,
        text: text.trim(),
      },
      include: {
        sender: {
          select: {
            name: true,
          },
        },
      },
    });

    // Notify the other user
    const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
    const sender = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    await (prisma as any).notification.create({
      data: {
        userId: otherUserId,
        type: 'system',
        title: '💬 Yeni Mesaj',
        body: `${sender?.name || 'Birisi'} sana mesaj gönderdi`,
        icon: '💬',
        actionType: 'navigate',
        actionTarget: `/nearby/chat/${matchId}`,
        relatedId: matchId,
      },
    });

    log.info(`Message sent in match ${matchId} by ${sender?.name}`);

    res.json({
      success: true,
      message: {
        id: message.id,
        text: message.text,
        sentAt: message.createdAt,
      },
    });
  } catch (err) {
    log.error('Send message error', err);
    res.status(500).json({ error: 'Mesaj gönderilemedi' });
  }
});

// ─────────────────────────────────────────────────────
// ICEBREAKER: Send Jest (token gift) to break ice
// Body: { targetUserId, amount }
// ─────────────────────────────────────────────────────
nearbyRoutes.post('/icebreaker', async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { targetUserId, amount } = req.body;

    if (!targetUserId || !amount || amount <= 0) {
      return res.status(400).json({ error: 'Geçersiz parametreler' });
    }

    const sender = await prisma.user.findUnique({ where: { id: userId } });
    if (!sender) {
      return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    }

    if (sender.tokenBalance < amount) {
      return res.status(400).json({ error: 'Yetersiz token bakiyesi' });
    }

    const recipient = await prisma.user.findUnique({ where: { id: targetUserId } });
    if (!recipient) {
      return res.status(404).json({ error: 'Hedef kullanıcı bulunamadı' });
    }

    // Atomic transaction: deduct tokens + create notification
    const result = await prisma.$transaction(async (tx) => {
      // Deduct from sender
      await tx.user.update({
        where: { id: userId },
        data: { tokenBalance: { decrement: amount } },
      });

      // Add to recipient
      await tx.user.update({
        where: { id: targetUserId },
        data: { tokenBalance: { increment: amount } },
      });

      // Log transaction
      const newSenderBalance = sender.tokenBalance - amount;
      const newRecipientBalance = recipient.tokenBalance + amount;

      await tx.tokenTransaction.create({
        data: {
          userId,
          amount: -amount,
          type: 'spend_purchase',
          source: `Jest Hediyesi — ${recipient.name}`,
          isCashable: false,
          balanceAfter: newSenderBalance,
        },
      });

      await tx.tokenTransaction.create({
        data: {
          userId: targetUserId,
          amount,
          type: 'earn_activity',
          source: `Jest Hediyesi — ${sender.name}`,
          isCashable: false,
          balanceAfter: newRecipientBalance,
        },
      });

      return { newSenderBalance, newRecipientBalance };
    });

    // Send notification to recipient
    await (prisma as any).notification.create({
      data: {
        userId: targetUserId,
        type: 'system',
        title: '🎁 Jest Hediyesi!',
        body: `${sender.name} sana ${amount} Jest gönderdim!`,
        icon: '🎁',
        actionType: 'navigate',
        actionTarget: '/wallet',
      },
    });

    log.info(`Jest gift: ${sender.name} → ${recipient.name} (${amount} tokens)`);

    res.json({
      success: true,
      senderNewBalance: result.newSenderBalance,
      recipientNewBalance: result.newRecipientBalance,
    });
  } catch (err) {
    log.error('Icebreaker error', err);
    res.status(500).json({ error: 'Jest gönderilemedi' });
  }
});

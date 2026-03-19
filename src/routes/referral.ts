// ─────────────────────────────────────────────────────
// VITA Referral Engine v2 — API Routes
// Activation-based rewards, Mystery Box, Leaderboard
// ─────────────────────────────────────────────────────

import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, requireAdmin } from '../middleware/auth';

export const referralRoutes = Router();

// ── REWARD TIERS (activation-based) ──
const REWARD_TIERS = [
  { activationsRequired: 3, reward: 500, label: 'Başlangıç' },
  { activationsRequired: 5, reward: 1500, label: 'Aktivist' },
  { activationsRequired: 10, reward: 5000, label: 'Büyükelçi' },
  { activationsRequired: 25, reward: 15000, label: 'Lider' },
  { activationsRequired: 50, reward: 35000, label: 'Elçi' },
  { activationsRequired: 75, reward: 50000, label: 'Efsane' },
  { activationsRequired: 100, reward: 75000, label: 'VITA Master' },
];

// ── MYSTERY BOX REWARDS (weighted random) ──
const MYSTERY_BOX_POOL = [
  { type: 'token', title: '100 Token', value: 100, rarity: 'common', weight: 25 },
  { type: 'token', title: '250 Token', value: 250, rarity: 'common', weight: 25 },
  { type: 'boost', title: '24 saat için x2 Bonus', value: 24, rarity: 'rare', weight: 15 },
  { type: 'gift_cert', title: 'Partner %10 indirim', value: 10, rarity: 'rare', weight: 15 },
  { type: 'token', title: '1000 Token', value: 1000, rarity: 'epic', weight: 10 },
  { type: 'premium_task', title: 'Premium Görev', value: 1, rarity: 'epic', weight: 5 },
  { type: 'token', title: '5000 Token', value: 5000, rarity: 'legendary', weight: 3 },
  { type: 'gift_cert', title: 'Sertifika 10000₸', value: 10000, rarity: 'legendary', weight: 2 },
];

function pickRandomReward() {
  const totalWeight = MYSTERY_BOX_POOL.reduce((sum, r) => sum + r.weight, 0);
  let random = Math.random() * totalWeight;
  for (const reward of MYSTERY_BOX_POOL) {
    random -= reward.weight;
    if (random <= 0) return reward;
  }
  return MYSTERY_BOX_POOL[0];
}

// Anti-fraud: max 20 invites per day
const MAX_DAILY_INVITES = 20;
const COOLDOWN_MINUTES = 2;

// ══════════════════════════════════════════════════════
// GET /api/referral/stats — User's referral statistics
// ══════════════════════════════════════════════════════

referralRoutes.get('/stats', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id;

    const [allReferrals, user] = await Promise.all([
      prisma.referral.findMany({ where: { referrerId: userId } }),
      prisma.user.findUnique({ where: { id: userId } }),
    ]);

    const totalInvited = allReferrals.length;
    const totalDownloaded = allReferrals.filter(r => r.status !== 'pending').length;
    const totalActivated = allReferrals.filter(r => r.status === 'activated').length;
    const totalTokensEarned = allReferrals.reduce((sum, r) => sum + r.tokensAwarded, 0);

    // Weekly stats
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weeklyInvites = allReferrals.filter(r => r.createdAt >= weekAgo).length;

    // Mystery boxes earned (1 per 3 activations)
    const mysteryBoxesEarned = Math.floor(totalActivated / 3);

    // Unclaimed mystery boxes
    const claimedBoxes = await prisma.mysteryBoxReward.count({
      where: { userId },
    });
    const pendingBoxes = Math.max(0, mysteryBoxesEarned - claimedBoxes);

    // Current tier
    let currentTier = null;
    let nextTier = REWARD_TIERS[0];
    for (let i = REWARD_TIERS.length - 1; i >= 0; i--) {
      if (totalActivated >= REWARD_TIERS[i].activationsRequired) {
        currentTier = REWARD_TIERS[i];
        nextTier = REWARD_TIERS[i + 1] || null;
        break;
      }
    }

    // Weekly rank
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    const leaderboardEntry = await prisma.leaderboardEntry.findUnique({
      where: { userId_weekStart: { userId, weekStart } },
    });

    res.json({
      referralCode: user?.referralCode,
      totalInvited,
      totalDownloaded,
      totalActivated,
      totalTokensEarned,
      weeklyInvites,
      weeklyRank: leaderboardEntry?.rank || 0,
      mysteryBoxesEarned,
      pendingMysteryBoxes: pendingBoxes,
      streakDays: user?.streakDays || 0,
      currentTier,
      nextTier,
      rewardTiers: REWARD_TIERS,
    });
  } catch (err) {
    console.error('Referral stats error:', err);
    res.status(500).json({ error: 'İstatistik yükleme hatası' });
  }
});

// ══════════════════════════════════════════════════════
// GET /api/referral/invites — List of invited friends
// ══════════════════════════════════════════════════════

referralRoutes.get('/invites', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { status } = req.query; // all | pending | downloaded | activated

    const where: any = { referrerId: userId };
    if (status && status !== 'all') {
      where.status = status;
    }

    const invites = await prisma.referral.findMany({
      where,
      include: {
        referred: {
          select: { id: true, name: true, phone: true, avatarUrl: true, createdAt: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(invites.map(inv => ({
      id: inv.id,
      status: inv.status,
      tokensAwarded: inv.tokensAwarded,
      firstTaskName: inv.firstTaskName,
      createdAt: inv.createdAt,
      activatedAt: inv.activatedAt,
      friend: inv.referred,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Davetiye yükleme hatası' });
  }
});

// ══════════════════════════════════════════════════════
// POST /api/referral/activate — Mark referral as activated
// Called when referred user completes first task
// ══════════════════════════════════════════════════════

referralRoutes.post('/activate', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id; // the referred user
    const { taskName } = req.body;

    // Find the referral where this user is the referred
    const referral = await prisma.referral.findFirst({
      where: { referredId: userId, status: { not: 'activated' } },
    });

    if (!referral) {
      return res.status(404).json({ error: 'Referans bulunamadı veya zaten etkinleştirildi' });
    }

    // Update referral status
    const rewardAmount = 100; // base reward for activation
    await prisma.referral.update({
      where: { id: referral.id },
      data: {
        status: 'activated',
        activatedAt: new Date(),
        firstTaskName: taskName || 'İlk Görev',
        tokensAwarded: rewardAmount,
      },
    });

    // Award tokens to referrer
    const referrer = await prisma.user.findUnique({ where: { id: referral.referrerId } });
    if (referrer) {
      await prisma.user.update({
        where: { id: referrer.id },
        data: { tokenBalance: { increment: rewardAmount } },
      });
      await prisma.tokenTransaction.create({
        data: {
          userId: referrer.id,
          amount: rewardAmount,
          type: 'earn_referral',
          source: `Arkadaş Aktivasyonu`,
          isCashable: false,
          balanceAfter: referrer.tokenBalance + rewardAmount,
          relatedId: referral.id,
        },
      });

      // Check tier rewards
      const totalActivated = await prisma.referral.count({
        where: { referrerId: referrer.id, status: 'activated' },
      });

      for (const tier of REWARD_TIERS) {
        if (totalActivated === tier.activationsRequired) {
          // Award tier bonus
          await prisma.user.update({
            where: { id: referrer.id },
            data: { tokenBalance: { increment: tier.reward } },
          });
          await prisma.tokenTransaction.create({
            data: {
              userId: referrer.id,
              amount: tier.reward,
              type: 'earn_referral',
              source: `Seviye Bonusu: ${tier.label}`,
              isCashable: false,
              balanceAfter: referrer.tokenBalance + rewardAmount + tier.reward,
              relatedId: referral.id,
            },
          });
          break;
        }
      }

      // Update weekly leaderboard
      const weekStart = new Date();
      weekStart.setDate(weekStart.getDate() - weekStart.getDay());
      weekStart.setHours(0, 0, 0, 0);

      await prisma.leaderboardEntry.upsert({
        where: { userId_weekStart: { userId: referrer.id, weekStart } },
        update: {
          activationCount: { increment: 1 },
          tokensEarned: { increment: rewardAmount },
        },
        create: {
          userId: referrer.id,
          weekStart,
          inviteCount: 0,
          activationCount: 1,
          tokensEarned: rewardAmount,
        },
      });
    }

    res.json({ success: true, tokensAwarded: rewardAmount });
  } catch (err) {
    console.error('Referral activate error:', err);
    res.status(500).json({ error: 'Referans aktivasyon hatası' });
  }
});

// ══════════════════════════════════════════════════════
// POST /api/referral/mystery-box/open — Open a mystery box
// ══════════════════════════════════════════════════════

referralRoutes.post('/mystery-box/open', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id;

    // Check if user has pending boxes
    const totalActivated = await prisma.referral.count({
      where: { referrerId: userId, status: 'activated' },
    });
    const boxesEarned = Math.floor(totalActivated / 3);
    const boxesClaimed = await prisma.mysteryBoxReward.count({ where: { userId } });

    if (boxesClaimed >= boxesEarned) {
      return res.status(400).json({ error: 'Kullanılabilir Mystery Box yok' });
    }

    // Pick random reward
    const picked = pickRandomReward();

    // Save reward
    const reward = await prisma.mysteryBoxReward.create({
      data: {
        userId,
        type: picked.type,
        title: picked.title,
        value: picked.value,
        rarity: picked.rarity,
        claimedAt: new Date(),
      },
    });

    // If token reward, add to balance
    if (picked.type === 'token') {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (user) {
        await prisma.user.update({
          where: { id: userId },
          data: { tokenBalance: { increment: picked.value } },
        });
        await prisma.tokenTransaction.create({
          data: {
            userId,
            amount: picked.value,
            type: 'earn_promo',
            source: `Mystery Box: ${picked.title}`,
            isCashable: false,
            balanceAfter: user.tokenBalance + picked.value,
            relatedId: reward.id,
          },
        });
      }
    }

    res.json({
      reward: {
        id: reward.id,
        type: picked.type,
        title: picked.title,
        value: picked.value,
        rarity: picked.rarity,
      },
    });
  } catch (err) {
    console.error('Mystery box error:', err);
    res.status(500).json({ error: 'Açılış hatası Mystery Box' });
  }
});

// ══════════════════════════════════════════════════════
// GET /api/referral/mystery-box/history — Past rewards
// ══════════════════════════════════════════════════════

referralRoutes.get('/mystery-box/history', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id;
    const rewards = await prisma.mysteryBoxReward.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(rewards);
  } catch (err) {
    res.status(500).json({ error: 'Geçmiş yükleme hatası' });
  }
});

// ══════════════════════════════════════════════════════
// GET /api/referral/leaderboard — Weekly leaderboard
// ══════════════════════════════════════════════════════

referralRoutes.get('/leaderboard', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id;

    // Current week start
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    // Get top 10
    const entries = await prisma.leaderboardEntry.findMany({
      where: { weekStart },
      orderBy: { activationCount: 'desc' },
      take: 10,
    });

    // Get user names
    const userIds = entries.map(e => e.userId);
    const users = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true, avatarUrl: true },
    });
    const userMap = new Map(users.map(u => [u.id, u]));

    // Get current user's entry
    const myEntry = await prisma.leaderboardEntry.findUnique({
      where: { userId_weekStart: { userId, weekStart } },
    });

    const leaderboard = entries.map((entry, index) => ({
      rank: index + 1,
      userId: entry.userId,
      name: userMap.get(entry.userId)?.name || 'Anonim',
      avatarUrl: userMap.get(entry.userId)?.avatarUrl,
      inviteCount: entry.inviteCount,
      activationCount: entry.activationCount,
      tokensEarned: entry.tokensEarned,
      isCurrentUser: entry.userId === userId,
    }));

    // Weekly prizes
    const prizes = [
      { rank: 1, prize: '10 000 token + Gold statüsü' },
      { rank: 2, prize: '5 000 token + Silver statüsü' },
      { rank: 3, prize: '2.500 token' },
    ];

    res.json({
      leaderboard,
      myPosition: myEntry ? {
        rank: leaderboard.find(l => l.isCurrentUser)?.rank || entries.length + 1,
        activationCount: myEntry.activationCount,
        tokensEarned: myEntry.tokensEarned,
      } : null,
      prizes,
      weekStart: weekStart.toISOString(),
    });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Liderlik tablosu yükleme hatası' });
  }
});

// ══════════════════════════════════════════════════════
// POST /api/referral/influencer-code/apply — Apply influencer code
// ══════════════════════════════════════════════════════

referralRoutes.post('/influencer-code/apply', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { code } = req.body;

    if (!code) {
      return res.status(400).json({ error: 'Kod zorunludur' });
    }

    const influencer = await prisma.influencerCode.findUnique({
      where: { code: code.toUpperCase() },
    });

    if (!influencer || !influencer.isActive) {
      return res.status(404).json({ error: 'Kod bulunamadı veya etkin değil' });
    }

    if (influencer.expiresAt && influencer.expiresAt < new Date()) {
      return res.status(400).json({ error: 'Kod süresi doldu' });
    }

    if (influencer.maxUsage && influencer.usageCount >= influencer.maxUsage) {
      return res.status(400).json({ error: 'Kod kullanım limiti tükendi' });
    }

    // Increment usage
    await prisma.influencerCode.update({
      where: { id: influencer.id },
      data: { usageCount: { increment: 1 } },
    });

    // Apply bonus tokens (100 * multiplier)
    const bonusTokens = Math.round(100 * influencer.bonusMultiplier);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (user) {
      await prisma.user.update({
        where: { id: userId },
        data: { tokenBalance: { increment: bonusTokens } },
      });
      await prisma.tokenTransaction.create({
        data: {
          userId,
          amount: bonusTokens,
          type: 'earn_promo',
          source: `Kod: ${influencer.influencerName}`,
          isCashable: false,
          balanceAfter: user.tokenBalance + bonusTokens,
        },
      });
    }

    res.json({
      success: true,
      influencerName: influencer.influencerName,
      bonusTokens,
      specialReward: influencer.specialReward,
    });
  } catch (err) {
    console.error('Influencer code error:', err);
    res.status(500).json({ error: 'Kod uygulama hatası' });
  }
});

// ══════════════════════════════════════════════════════
// Admin: GET /api/referral/admin/influencer-codes — Manage codes
// ══════════════════════════════════════════════════════

referralRoutes.get('/admin/influencer-codes', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const codes = await prisma.influencerCode.findMany({
      orderBy: { createdAt: 'desc' },
    });
    res.json(codes);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

referralRoutes.post('/admin/influencer-codes', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { code, influencerName, platform, bonusMultiplier, specialReward, maxUsage, expiresAt } = req.body;

    const created = await prisma.influencerCode.create({
      data: {
        code: code.toUpperCase(),
        influencerName,
        platform,
        bonusMultiplier: bonusMultiplier || 1.0,
        specialReward,
        maxUsage,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
    });

    res.json(created);
  } catch (err) {
    console.error('Create influencer code error:', err);
    res.status(500).json({ error: 'Kod oluşturma hatası' });
  }
});

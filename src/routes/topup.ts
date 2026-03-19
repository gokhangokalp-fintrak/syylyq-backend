import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';

export const topupRoutes = Router();

// ══════════════════════════════════════════════════════
// DISABLED: Token top-up (yeni modelde token satın alınamaz)
// Tokenlar sadece aktivitelerden kazanılır:
// - Referral (arkadaş davet)
// - Gizli Müşteri (mystery shopper görevleri)
// - Günlük bonus, oyunlar, gamification
// - Hediye çeki → token dönüşümü
// ══════════════════════════════════════════════════════

topupRoutes.post('/create', requireAuth, async (_req, res) => {
  res.status(403).json({
    error: 'Token yükleme işlevi kullanılamaz',
    message: 'Arkadaş davetleri, Gizli Müşteri, günlük görevler ve oyunlar aracılığıyla token kazanın!',
    comingSoon: true,
    earnMethods: [
      { method: 'referral', description: 'Bir arkadaşı davet edin - 500 token alın', icon: '🎁' },
      { method: 'mystery_shopper', description: 'Gizli Müşteri görevini tamamlayın', icon: '🕵️' },
      { method: 'daily_bonus', description: 'Günlük bonus ve gün serisi', icon: '🎰' },
      { method: 'games', description: 'Mini oyunları oynayın', icon: '🎮' },
      { method: 'convert_card', description: 'Hediye sertifikasını dönüştürün', icon: '🔄' },
    ],
  });
});

// Webhook hala aktif — gelecekte PSP entegrasyonu için (hediye çeki satışı)
topupRoutes.post('/webhook', async (req, res) => {
  // PSP webhook'u — hediye çeki satın alımlarını onaylamak için
  // Şimdilik devre dışı, PSP entegrasyonunda aktif olacak
  console.log('⚠️ TopUp webhook called but token top-up is disabled');
  res.status(200).json({ received: true, note: 'Token top-up is currently disabled' });
});

// History hala çalışsın (eski kayıtlar görüntülenebilir)
topupRoutes.get('/history', requireAuth, async (req, res) => {
  try {
    const orders = await prisma.topUpOrder.findMany({
      where: { userId: req.auth!.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    res.json(orders);
  } catch (err) {
    res.status(500).json({ error: 'Geçmiş yükleme hatası' });
  }
});

// Admin confirm de devre dışı
topupRoutes.post('/confirm/:orderId', async (_req, res) => {
  res.status(403).json({
    error: 'Token yükleme işlevi kullanılamaz',
    comingSoon: true,
  });
});

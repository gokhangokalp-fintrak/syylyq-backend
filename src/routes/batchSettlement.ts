import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, requireAdmin } from '../middleware/auth';

export const batchSettlementRoutes = Router();

// All batch settlement routes require admin
batchSettlementRoutes.use(requireAuth, requireAdmin);

// ══════════════════════════════════════════════════════
// BATCH SETTLEMENT — Günlük Toplu Ödeme Sistemi
//
// Akış:
//   1. Her akşam (veya manual) "prepare" çalışır
//   2. Tüm pending settlement'lar merchant bazında toplanır
//   3. Her merchant için BatchSettlement oluşturulur
//   4. Ledger'a "debit" kaydı düşer (VITA borçlanır)
//   5. Ertesi gün "execute" ile toplu ödeme yapılır
//   6. Başarılı ödemelerde ledger'a "credit" kaydı düşer
//
// Güvenlik:
//   - Batch sadece admin tarafından tetiklenebilir
//   - Her adımda audit log tutulur
//   - Çift ödeme kontrolü (@@unique batchDate+merchantId)
// ══════════════════════════════════════════════════════

// ── Step 1: Prepare nightly batch (aggregate pending settlements) ──
// Bu endpoint her akşam çağrılır (cron veya manual)
batchSettlementRoutes.post('/prepare', async (req, res) => {
  try {
    const { batchDate } = req.body;
    const dateStr = batchDate || new Date().toISOString().slice(0, 10); // "2026-03-16"

    console.log(`📦 Preparing batch settlement for ${dateStr}...`);

    // Bugünün sonuna kadar olan tüm pending settlement'ları bul
    const cutoffDate = new Date(dateStr);
    cutoffDate.setHours(23, 59, 59, 999);

    const pendingSettlements = await prisma.settlement.findMany({
      where: {
        status: 'pending',
        createdAt: { lte: cutoffDate },
      },
      include: {
        merchant: true,
      },
    });

    if (pendingSettlements.length === 0) {
      return res.json({
        message: 'Bekleyen ödeme yok',
        batchDate: dateStr,
        batchesCreated: 0,
      });
    }

    // Merchant bazında grupla
    const merchantGroups: Record<string, typeof pendingSettlements> = {};
    for (const s of pendingSettlements) {
      if (!merchantGroups[s.merchantId]) {
        merchantGroups[s.merchantId] = [];
      }
      merchantGroups[s.merchantId].push(s);
    }

    const batchResults: any[] = [];

    for (const [merchantId, settlements] of Object.entries(merchantGroups)) {
      const merchant = settlements[0].merchant;

      // Toplamları hesapla
      const totalGross = settlements.reduce((sum, s) => sum + s.totalAmount, 0);
      const totalCommission = settlements.reduce((sum, s) => sum + s.commissionAmount, 0);
      const totalNet = settlements.reduce((sum, s) => sum + s.netAmount, 0);

      // BatchSettlement oluştur (unique constraint: batchDate + merchantId)
      let batch: any;
      try {
        batch = await (prisma as any).batchSettlement.create({
          data: {
            batchDate: dateStr,
            merchantId,
            totalGross,
            totalCommission,
            totalNet,
            itemCount: settlements.length,
            method: merchant.settlementMethod,
            bankAccount: merchant.bankAccount,
            bankName: merchant.bankName,
            binIin: merchant.binIin,
            status: 'pending',
          },
        });
      } catch (err: any) {
        // Unique constraint — bu gün bu merchant için zaten batch var
        if (err.code === 'P2002') {
          console.log(`⚠️ Batch already exists for ${merchant.name} on ${dateStr}, skipping`);
          continue;
        }
        throw err;
      }

      // Settlement'ları batch'e bağla ve "batched" olarak işaretle
      await prisma.settlement.updateMany({
        where: { id: { in: settlements.map(s => s.id) } },
        data: { status: 'batched', batchId: batch.id } as any,
      });

      // Ledger kaydı — VITA merchant'a borçlanır (debit)
      // Mevcut cari bakiyeyi hesapla
      const lastLedger = await (prisma as any).ledgerEntry.findFirst({
        where: { merchantId },
        orderBy: { createdAt: 'desc' },
      });
      const currentBalance = lastLedger?.balance || 0;
      const newBalance = currentBalance + totalNet; // borç artar

      await (prisma as any).ledgerEntry.create({
        data: {
          merchantId,
          type: 'debit_redemption',
          description: `Günlük hesaplama (${dateStr}): ${settlements.length} işlem, brüt ${totalGross}₸, komisyon ${totalCommission}₸`,
          debit: totalNet,
          credit: 0,
          balance: newBalance,
          relatedId: batch.id,
        },
      });

      batchResults.push({
        batchId: batch.id,
        merchantName: merchant.name,
        merchantId,
        itemCount: settlements.length,
        totalGross,
        totalCommission,
        totalNet,
        method: merchant.settlementMethod,
        bankAccount: merchant.bankAccount ? `***${merchant.bankAccount.slice(-4)}` : 'Belirtilmedi',
      });

      console.log(`📦 Batch created: ${merchant.name} — ${totalNet}₸ net (${settlements.length} items)`);
    }

    res.json({
      batchDate: dateStr,
      batchesCreated: batchResults.length,
      totalMerchants: batchResults.length,
      totalNetPayable: batchResults.reduce((sum, b) => sum + b.totalNet, 0),
      batches: batchResults,
    });
  } catch (err) {
    console.error('Batch prepare error:', err);
    res.status(500).json({ error: 'Paket hazırlama sunucu hatası' });
  }
});

// ── Step 2: Execute batch payments ──
// Tüm pending batch'leri öde (veya belirli bir batch'i)
batchSettlementRoutes.post('/execute', async (req, res) => {
  try {
    const { batchId, batchDate } = req.body;
    const adminId = req.auth!.id;

    // Ödenecek batch'leri bul
    const where: any = { status: 'pending' };
    if (batchId) {
      where.id = batchId;
    } else if (batchDate) {
      where.batchDate = batchDate;
    }

    const batches = await (prisma as any).batchSettlement.findMany({
      where,
      include: { merchantObj: true },
    });

    if (batches.length === 0) {
      return res.json({ message: 'Bekleyen paket yok', executed: 0 });
    }

    const results: any[] = [];

    for (const batch of batches) {
      // Banka bilgisi kontrol
      if (!batch.bankAccount) {
        await (prisma as any).batchSettlement.update({
          where: { id: batch.id },
          data: {
            status: 'failed',
            failureReason: 'Banka bilgileri belirtilmedi',
          },
        });
        results.push({
          batchId: batch.id,
          merchantName: batch.merchantObj.name,
          status: 'failed',
          reason: 'Banka bilgileri yok',
        });
        continue;
      }

      // Ödeme işlemi başlat
      await (prisma as any).batchSettlement.update({
        where: { id: batch.id },
        data: { status: 'processing', processedBy: adminId },
      });

      // PSP API çağrısı (MVP: simulated)
      const paymentResult = await executeBatchPayment({
        merchantId: batch.merchantId,
        amount: batch.totalNet,
        method: batch.method,
        bankAccount: batch.bankAccount,
        bankName: batch.bankName,
        binIin: batch.binIin,
        reference: batch.id,
      });

      if (paymentResult.success) {
        // Batch başarılı
        await (prisma as any).batchSettlement.update({
          where: { id: batch.id },
          data: {
            status: 'completed',
            reference: paymentResult.transactionRef,
            processedAt: new Date(),
          },
        });

        // İlgili settlement'ları completed yap
        await prisma.settlement.updateMany({
          where: { batchId: batch.id } as any,
          data: { status: 'completed', processedAt: new Date(), reference: paymentResult.transactionRef },
        });

        // Ledger kaydı — ödeme yapıldı (credit)
        const lastLedger = await (prisma as any).ledgerEntry.findFirst({
          where: { merchantId: batch.merchantId },
          orderBy: { createdAt: 'desc' },
        });
        const currentBalance = lastLedger?.balance || 0;
        const newBalance = currentBalance - batch.totalNet; // borç azalır

        await (prisma as any).ledgerEntry.create({
          data: {
            merchantId: batch.merchantId,
            type: 'credit_batch_payment',
            description: `Batch ödeme (${batch.batchDate}): ${batch.totalNet}₸ — ${batch.method} ${paymentResult.transactionRef}`,
            debit: 0,
            credit: batch.totalNet,
            balance: newBalance,
            relatedId: batch.id,
            batchId: batch.id,
          },
        });

        console.log(`✅ Batch payment completed: ${batch.merchantObj.name} — ${batch.totalNet}₸ (ref: ${paymentResult.transactionRef})`);

        results.push({
          batchId: batch.id,
          merchantName: batch.merchantObj.name,
          amount: batch.totalNet,
          status: 'completed',
          reference: paymentResult.transactionRef,
        });
      } else {
        // Ödeme başarısız
        await (prisma as any).batchSettlement.update({
          where: { id: batch.id },
          data: {
            status: 'failed',
            failureReason: paymentResult.error,
          },
        });

        results.push({
          batchId: batch.id,
          merchantName: batch.merchantObj.name,
          amount: batch.totalNet,
          status: 'failed',
          reason: paymentResult.error,
        });
      }
    }

    const completed = results.filter(r => r.status === 'completed');
    const failed = results.filter(r => r.status === 'failed');

    res.json({
      executed: results.length,
      completed: completed.length,
      failed: failed.length,
      totalPaid: completed.reduce((sum, r) => sum + (r.amount || 0), 0),
      results,
    });
  } catch (err) {
    console.error('Batch execute error:', err);
    res.status(500).json({ error: 'Paket yürütme sunucu hatası' });
  }
});

// ── Retry failed batch ──
batchSettlementRoutes.post('/:batchId/retry', async (req, res) => {
  try {
    const { batchId } = req.params;

    const batch = await (prisma as any).batchSettlement.findUnique({
      where: { id: batchId },
      include: { merchantObj: true },
    });

    if (!batch) {
      return res.status(404).json({ error: 'Paket bulunamadı' });
    }

    if (batch.status !== 'failed') {
      return res.status(400).json({ error: `Tekrar mümkün değil (durum: ${batch.status})` });
    }

    // Retry: reset to pending
    await (prisma as any).batchSettlement.update({
      where: { id: batchId },
      data: { status: 'pending', failureReason: null },
    });

    res.json({
      success: true,
      message: `Paket ${batch.merchantObj.name} (${batch.totalNet}₸) yeniden başlat. hazır`,
    });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── List all batches (with filters) ──
batchSettlementRoutes.get('/', async (req, res) => {
  try {
    const { status, batchDate, merchantId, limit = '50' } = req.query;
    const where: any = {};
    if (status) where.status = status;
    if (batchDate) where.batchDate = batchDate;
    if (merchantId) where.merchantId = merchantId;

    const batches = await (prisma as any).batchSettlement.findMany({
      where,
      include: {
        merchantObj: {
          select: { name: true, settlementMethod: true, bankAccount: true, bankName: true, binIin: true },
        },
        _count: { select: { settlements: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit as string),
    });

    // Özet istatistikler
    const summary = await (prisma as any).batchSettlement.aggregate({
      where,
      _sum: { totalGross: true, totalCommission: true, totalNet: true },
      _count: true,
    });

    res.json({
      batches,
      summary: {
        count: summary._count,
        totalGross: summary._sum.totalGross || 0,
        totalCommission: summary._sum.totalCommission || 0,
        totalNet: summary._sum.totalNet || 0,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Paket yükleme hatası' });
  }
});

// ── Batch detail ──
batchSettlementRoutes.get('/:batchId', async (req, res) => {
  try {
    const batch = await (prisma as any).batchSettlement.findUnique({
      where: { id: req.params.batchId },
      include: {
        merchantObj: true,
        settlements: {
          include: {
            redemptions: {
              include: {
                giftCard: { select: { code: true, amount: true } },
                branch: { select: { name: true } },
              },
            },
          },
        },
        ledgerEntry: true,
      },
    });

    if (!batch) {
      return res.status(404).json({ error: 'Paket bulunamadı' });
    }

    res.json(batch);
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ── Dashboard: daily overview for admin ──
batchSettlementRoutes.get('/dashboard/overview', async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Bugünün pending settlement'ları (henüz batch'lenmemiş)
    const pendingSettlements = await prisma.settlement.aggregate({
      where: { status: 'pending' },
      _sum: { netAmount: true, totalAmount: true, commissionAmount: true },
      _count: true,
    });

    // Bugünün batch'leri
    const todayBatches = await (prisma as any).batchSettlement.aggregate({
      where: { batchDate: today },
      _sum: { totalNet: true, totalGross: true, totalCommission: true },
      _count: true,
    });

    // Ödeme bekleyen batch'ler (tüm günler)
    const pendingBatches = await (prisma as any).batchSettlement.aggregate({
      where: { status: 'pending' },
      _sum: { totalNet: true },
      _count: true,
    });

    // Son 7 günün tamamlanmış ödemeleri
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const recentPayments = await (prisma as any).batchSettlement.aggregate({
      where: {
        status: 'completed',
        processedAt: { gte: sevenDaysAgo },
      },
      _sum: { totalNet: true, totalCommission: true },
      _count: true,
    });

    // Başarısız batch'ler
    const failedBatches = await (prisma as any).batchSettlement.count({
      where: { status: 'failed' },
    });

    // Merchant sayısı (banka bilgisi eksik)
    const merchantsWithoutBank = await prisma.merchant.count({
      where: {
        approvalStatus: 'approved',
        OR: [
          { bankAccount: null },
          { bankAccount: '' },
        ],
      },
    });

    res.json({
      unbatched: {
        count: pendingSettlements._count,
        totalNet: pendingSettlements._sum.netAmount || 0,
        totalGross: pendingSettlements._sum.totalAmount || 0,
        commission: pendingSettlements._sum.commissionAmount || 0,
      },
      todayBatches: {
        count: todayBatches._count,
        totalNet: todayBatches._sum?.totalNet || 0,
      },
      pendingPayment: {
        count: pendingBatches._count,
        totalNet: pendingBatches._sum?.totalNet || 0,
      },
      last7Days: {
        paid: recentPayments._count,
        totalPaid: recentPayments._sum?.totalNet || 0,
        commissionEarned: recentPayments._sum?.totalCommission || 0,
      },
      alerts: {
        failedBatches,
        merchantsWithoutBank,
      },
    });
  } catch (err) {
    res.status(500).json({ error: 'Sunucu hatası' });
  }
});

// ══════════════════════════════════════════════════════
// PSP Payment Processor (MVP: simulated)
// Production'da: Kaspi Business API / Halyk Business API
// ══════════════════════════════════════════════════════

async function executeBatchPayment(params: {
  merchantId: string;
  amount: number;
  method: string;
  bankAccount: string;
  bankName: string | null;
  binIin: string | null;
  reference: string;
}): Promise<{ success: boolean; transactionRef?: string; error?: string }> {
  console.log(`💰 Processing batch payment:
    Merchant: ${params.merchantId}
    Amount: ${params.amount}₸
    Method: ${params.method}
    Bank: ${params.bankName} — ${params.bankAccount}
    BIN/IIN: ${params.binIin}
    Ref: ${params.reference}
  `);

  // TODO: Production'da burada PSP API çağrısı olacak
  // Kaspi Business API: POST /api/v1/transfers
  // Halyk Business API: POST /api/payments/batch
  //
  // Güvenlik:
  // - İdempotent key: batch.id (çift ödeme önleme)
  // - Webhook callback: ödeme durumu güncellemesi
  // - Retry with exponential backoff on failure

  // MVP: Simulate 98% success rate
  const success = Math.random() > 0.02;

  return {
    success,
    transactionRef: success ? `BATCH-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` : undefined,
    error: success ? undefined : 'Banka transferi geçici olarak kullanılamaz - 1 saat içinde yeniden deneyin',
  };
}

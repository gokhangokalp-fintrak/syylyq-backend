// ─────────────────────────────────────────────────────
// VITA Platform — iyzico Payment Integration
// Türkiye'nin öncü ödeme sağlayıcısı
// ─────────────────────────────────────────────────────
// TODO: npm install iyzipay
// TODO: Real iyzico API integration with:
// - Sandbox: https://sandbox-api.iyzipay.com
// - Production: https://api.iyzipay.com
// ─────────────────────────────────────────────────────

import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMerchant, requireAdmin } from '../middleware/auth';

export const iyzicoRoutes = Router();

// ── Configuration ──
const IYZICO_ENV = process.env.IYZICO_ENV || 'sandbox';
const IYZICO_API_KEY = process.env.IYZICO_API_KEY || 'mock-test-key';
const IYZICO_SECRET_KEY = process.env.IYZICO_SECRET_KEY || 'mock-test-secret';

const IYZICO_API_URLS = {
  sandbox: 'https://sandbox-api.iyzipay.com',
  production: 'https://api.iyzipay.com',
} as const;

const IYZICO_API_URL = IYZICO_API_URLS[IYZICO_ENV as keyof typeof IYZICO_API_URLS];

console.log(`[iyzico] Initialized: ${IYZICO_ENV} — ${IYZICO_API_URL}`);

// ══════════════════════════════════════════════════════
// PAYMENT INITIALIZATION — 3D Secure Flow
// ══════════════════════════════════════════════════════

/**
 * POST /api/payment/initialize
 * Initialize iyzico 3D Secure payment
 *
 * Body: {
 *   amount: number (in kuruş),
 *   currency: 'TRY',
 *   cardHolderName: string,
 *   cardNumber: string (16 digits),
 *   expireMonth: number (1-12),
 *   expireYear: number (YY),
 *   cvc: string (3-4 digits),
 *   description: string
 * }
 *
 * Response: {
 *   status: 'success' | 'error',
 *   paymentId: string,
 *   conversationId: string,
 *   htmlContent: string (3DS redirect form),
 *   redirectUrl: string
 * }
 */
iyzicoRoutes.post('/initialize', requireAuth, async (req: Request, res: Response) => {
  try {
    const { amount, currency = 'TRY', cardHolderName, cardNumber, expireMonth, expireYear, cvc, description } = req.body;

    // Validation
    if (!amount || !cardHolderName || !cardNumber || !expireMonth || !expireYear || !cvc) {
      return res.status(400).json({
        status: 'error',
        message: 'Eksik bilgiler. Lütfen tüm alan doldur.',
      });
    }

    if (amount < 100) {
      return res.status(400).json({
        status: 'error',
        message: 'Asgari ödeme tutarı 1 TL (100 kuruş).',
      });
    }

    const paymentId = `pay_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const conversationId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // TODO: Call real iyzico API
    // import Iyzipay from 'iyzipay';
    // const iyzipay = new Iyzipay({
    //   apiKey: IYZICO_API_KEY,
    //   secretKey: IYZICO_SECRET_KEY,
    //   uri: IYZICO_API_URL,
    // });
    //
    // const paymentRequest = {
    //   locale: 'tr',
    //   conversationId,
    //   price: String(amount / 100),
    //   paidPrice: String(amount / 100),
    //   currency,
    //   installment: '1',
    //   paymentChannel: 'WEB',
    //   paymentGroup: 'PRODUCT',
    //   paymentCard: {
    //     cardHolderName,
    //     cardNumber,
    //     expireMonth: String(expireMonth),
    //     expireYear: String(expireYear),
    //     cvc,
    //   },
    //   buyer: {
    //     id: req.auth!.id,
    //     name: 'User',
    //     surname: 'VITA',
    //     gsmNumber: '+90...',
    //     email: 'user@vita.tr',
    //     identityNumber: '00000000000',
    //     registrationAddress: 'Türkiye',
    //     ip: req.ip,
    //     city: 'Istanbul',
    //     country: 'Turkey',
    //     zipCode: '34000',
    //   },
    //   shippingAddress: { ... },
    //   billingAddress: { ... },
    // };
    //
    // iyzipay.payment.create(paymentRequest, (err, result) => {
    //   if (err) return res.status(500).json({ status: 'error', message: err.message });
    //   // Handle 3D Secure
    //   if (result.threeDSecure === 'true') {
    //     return res.json({
    //       status: 'success',
    //       paymentId: result.paymentId,
    //       conversationId: result.conversationId,
    //       htmlContent: result.htmlContent,
    //       threeDSecure: true,
    //     });
    //   }
    // });

    // MOCK RESPONSE (simulating iyzico's 3D Secure flow)
    const mockHtmlContent = `
      <!DOCTYPE html>
      <html lang="tr">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>iyzico 3D Secure Doğrulama</title>
          <style>
            body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; background: #f5f5f5; }
            .container { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 400px; }
            h2 { color: #333; text-align: center; }
            .info { font-size: 14px; color: #666; margin: 20px 0; }
            .amount { font-size: 24px; font-weight: bold; color: #0066cc; text-align: center; margin: 20px 0; }
            form { margin-top: 30px; }
            input, button { width: 100%; padding: 12px; margin: 10px 0; font-size: 14px; }
            input { border: 1px solid #ddd; border-radius: 4px; }
            button { background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; }
            button:hover { background: #0052a3; }
          </style>
        </head>
        <body>
          <div class="container">
            <h2>3D Secure Doğrulama</h2>
            <p class="info">iyzico güvenli ödeme sistemi sizi doğrulamak üzere yönlendiriyor.</p>
            <div class="amount">${(amount / 100).toFixed(2)} TL</div>
            <form method="POST" action="http://localhost:3001/api/payment/callback" id="threeDForm">
              <input type="hidden" name="paymentId" value="${paymentId}" />
              <input type="hidden" name="conversationId" value="${conversationId}" />
              <input type="hidden" name="userId" value="${req.auth!.id}" />
              <input type="text" placeholder="3D Secure Şifreniz" name="otp" required />
              <button type="submit">Doğrula</button>
            </form>
            <p style="text-align: center; color: #999; font-size: 12px; margin-top: 20px;">
              Test mod: 123456 girin
            </p>
            <script>
              // Auto-submit for mock testing
              setTimeout(() => {
                document.getElementById('threeDForm').submit();
              }, 2000);
            </script>
          </div>
        </body>
      </html>
    `;

    // Save payment to database (mock)
    console.log(`[iyzico] Payment initialized: ${paymentId} for user ${req.auth!.id}`);

    return res.json({
      status: 'success',
      paymentId,
      conversationId,
      htmlContent: mockHtmlContent,
      threeDSecure: true,
      redirectUrl: `${IYZICO_API_URL}/payment/3dsecure/auth`,
    });
  } catch (err: any) {
    console.error('[iyzico] Initialize error:', err);
    res.status(500).json({
      status: 'error',
      message: 'Ödeme başlatılamadı',
      error: err.message,
    });
  }
});

// ══════════════════════════════════════════════════════
// CALLBACK — 3D Secure Verification
// ══════════════════════════════════════════════════════

/**
 * POST /api/payment/callback
 * iyzico 3D Secure callback (webhook)
 * Called after 3D Secure verification
 */
iyzicoRoutes.post('/callback', async (req: Request, res: Response) => {
  try {
    const { paymentId, conversationId, userId, otp } = req.body;

    // TODO: Verify with iyzico API that payment is confirmed
    // iyzipay.payment.retrieve({ conversationId }, (err, result) => {
    //   if (result.paymentStatus === 'SUCCESS') {
    //     // Credit user's wallet
    //   }
    // });

    // MOCK: Accept test OTP
    if (otp === '123456' || otp === '1234') {
      console.log(`[iyzico] Payment callback: ${paymentId} verified for user ${userId}`);

      // Update user's wallet
      const tokenAmount = Math.floor(Math.random() * 500) + 50; // 50-550 tokens

      await prisma.user.update({
        where: { id: userId },
        data: {
          tokenBalance: { increment: tokenAmount },
        },
      });

      return res.json({
        status: 'success',
        paymentId,
        conversationId,
        message: 'Ödeme başarıyla tamamlandı',
        tokensAdded: tokenAmount,
      });
    } else {
      return res.status(400).json({
        status: 'error',
        message: 'Doğrulama başarısız',
        paymentId,
      });
    }
  } catch (err: any) {
    console.error('[iyzico] Callback error:', err);
    res.status(500).json({
      status: 'error',
      message: 'İşlem sırasında hata oluştu',
    });
  }
});

// ══════════════════════════════════════════════════════
// STATUS CHECK
// ══════════════════════════════════════════════════════

/**
 * GET /api/payment/status/:paymentId
 * Check payment status
 */
iyzicoRoutes.get('/status/:paymentId', requireAuth, async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;

    // TODO: Query iyzico API or database
    // iyzipay.payment.retrieve({ paymentId }, (err, result) => {
    //   res.json({
    //     status: result.paymentStatus, // SUCCESS, FAILURE, PENDING, etc.
    //     amount: result.paidPrice,
    //     currency: result.currency,
    //     paymentDate: result.paymentDate,
    //   });
    // });

    // MOCK
    res.json({
      status: 'pending',
      paymentId,
      message: 'Ödeme durumu: İşlem bekleniyor',
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Durum kontrol edilemedi' });
  }
});

// ══════════════════════════════════════════════════════
// TOKEN TOP-UP (Wallet Funding)
// ══════════════════════════════════════════════════════

/**
 * POST /api/payment/topup
 * Top up wallet via iyzico
 * 1 TL = 1 VITA token
 *
 * Body: { amount: number (TL) }
 * Response: { paymentId, htmlContent (3DS form) }
 */
iyzicoRoutes.post('/topup', requireAuth, async (req: Request, res: Response) => {
  try {
    const { amount } = req.body;

    if (!amount || amount < 1 || amount > 100000) {
      return res.status(400).json({
        error: 'Geçersiz tutar. 1-100000 TL arasında tuttar.',
      });
    }

    const amountInKurus = Math.floor(amount * 100);

    // TODO: Call iyzico payment initialization
    const paymentId = `topup_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    res.json({
      status: 'success',
      paymentId,
      amount,
      currency: 'TRY',
      tokensWillReceive: amount, // 1 TL = 1 token
      message: 'Ödeme ekranına yönlendiriliyorsunuz...',
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Top-up başlatılamadı' });
  }
});

// ══════════════════════════════════════════════════════
// WITHDRAWAL (Withdrawal Request)
// ══════════════════════════════════════════════════════

/**
 * POST /api/payment/withdraw
 * Request withdrawal to bank account
 *
 * Body: {
 *   amount: number (TL),
 *   iban: string (TR...),
 *   bankName: string,
 *   accountHolder: string
 * }
 *
 * Min: 50 TL, Max: 10000 TL
 * Requires admin approval
 */
iyzicoRoutes.post('/withdraw', requireAuth, async (req: Request, res: Response) => {
  try {
    const { amount, iban, bankName, accountHolder } = req.body;

    // Validation
    if (!amount || !iban || !bankName || !accountHolder) {
      return res.status(400).json({
        error: 'Eksik bilgiler',
        required: ['amount', 'iban', 'bankName', 'accountHolder'],
      });
    }

    if (amount < 50 || amount > 10000) {
      return res.status(400).json({
        error: 'Çekim tutarı 50-10000 TL arasında olmalıdır',
      });
    }

    // Check user wallet
    const user = await prisma.user.findUnique({
      where: { id: req.auth!.id },
      select: { tokenBalance: true },
    });

    if (!user || user.tokenBalance < amount) {
      return res.status(400).json({
        error: 'Yetersiz bakiye',
        available: user?.tokenBalance || 0,
      });
    }

    // TODO: Create withdrawal request for admin approval
    // iyzico payout yapıldığında withdrawal status güncelle

    const withdrawalId = `wd_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    res.json({
      status: 'pending_approval',
      withdrawalId,
      amount,
      iban,
      bankName,
      accountHolder,
      message: 'Çekim talebiniz admin tarafından onay için gönderildi',
      estimatedDays: '1-2 iş günü',
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Çekim talebı oluşturulamadı' });
  }
});

// ══════════════════════════════════════════════════════
// SUBMERCHANT REGISTRATION (Marketplace Payouts)
// ══════════════════════════════════════════════════════

/**
 * POST /api/payment/submerchant/create
 * Register merchant as iyzico submerchant for marketplace payouts
 *
 * Body: {
 *   merchantId: string,
 *   iban: string (TR...),
 *   contactName: string,
 *   contactSurname: string,
 *   email: string,
 *   phone: string
 * }
 */
iyzicoRoutes.post('/submerchant/create', requireMerchant, async (req: Request, res: Response) => {
  try {
    const { merchantId, iban, contactName, contactSurname, email, phone } = req.body;

    if (!merchantId || !iban || !contactName || !contactSurname || !email) {
      return res.status(400).json({
        error: 'Eksik bilgiler',
      });
    }

    // TODO: Call iyzico SubMerchant API
    // POST /submerchant
    // {
    //   "type": "PERSONAL",
    //   "name": contactName,
    //   "surname": contactSurname,
    //   "identityNumber": "...",
    //   "email": email,
    //   "gsmNumber": phone,
    //   "currency": "TRY",
    //   "iban": iban,
    //   "address": "..."
    // }

    const subMerchantKey = `sm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    console.log(`[iyzico] SubMerchant created: ${subMerchantKey} for merchant ${merchantId}`);

    res.json({
      status: 'success',
      subMerchantKey,
      merchantId,
      message: 'Alt işletme başarıyla kaydedildi',
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Alt işletme kaydı başarısız' });
  }
});

// ══════════════════════════════════════════════════════
// SETTLEMENT HISTORY (Merchant View)
// ══════════════════════════════════════════════════════

/**
 * GET /api/payment/settlements
 * Get merchant settlement history
 */
iyzicoRoutes.get('/settlements', requireAuth, async (req: Request, res: Response) => {
  try {
    // TODO: Query settlement history from database or iyzico API
    // iyzipay.settlement.list({}, (err, result) => { ... })

    res.json({
      status: 'success',
      settlements: [],
      message: 'Henüz settlement kaydı yok',
      nextSettlementDate: '2026-03-20',
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Settlement geçmişi alınamadı' });
  }
});

// ══════════════════════════════════════════════════════
// ADMIN: PAYMENT MANAGEMENT
// ══════════════════════════════════════════════════════

/**
 * POST /api/payment/admin/approve-withdrawal
 * Admin approve withdrawal
 */
iyzicoRoutes.post('/admin/approve-withdrawal', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { withdrawalId } = req.body;

    // TODO: Call iyzico payout API
    // iyzipay.payout.create({ ... })

    res.json({
      status: 'success',
      withdrawalId,
      message: 'Çekim onaylandı ve işlem başlatıldı',
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Onay başarısız' });
  }
});

/**
 * POST /api/payment/admin/reject-withdrawal
 * Admin reject withdrawal
 */
iyzicoRoutes.post('/admin/reject-withdrawal', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { withdrawalId, reason } = req.body;

    res.json({
      status: 'success',
      withdrawalId,
      message: 'Çekim talebi reddedildi',
      reason,
    });
  } catch (err: any) {
    res.status(500).json({ error: 'Red işlemi başarısız' });
  }
});

// ─────────────────────────────────────────────────────
// VITA Platform — Backend API Server
// Express.js + Prisma + SQLite + JWT
// ─────────────────────────────────────────────────────

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { prisma } from './lib/prisma';
import { cityRoutes } from './routes/cities';
import { merchantRoutes } from './routes/merchants';
import { giftCardRoutes } from './routes/giftCards';
import { redemptionRoutes } from './routes/redemption';
import { settlementRoutes } from './routes/settlements';
import { authRoutes } from './routes/auth';
import { tokenRoutes } from './routes/tokens';
import { topupRoutes } from './routes/topup';
import { adminRoutes } from './routes/admin';
import { merchantPanelRoutes } from './routes/merchantPanel';
import { referralRoutes } from './routes/referral';
import { mysteryTaskRoutes } from './routes/mysteryTasks';
import { batchSettlementRoutes } from './routes/batchSettlement';
import { iyzicoRoutes } from './routes/iyzico';
import { generalLimiter, authLimiter, paymentLimiter, adminLimiter } from './middleware/rateLimiter';
import { notificationRoutes } from './routes/notifications';
import { connectionRoutes } from './routes/connections';
import { groupRoutes } from './routes/groups';
import { nearbyRoutes } from './routes/nearby';
import { jobsRoutes } from './routes/jobs';
import { dealsRoutes } from './routes/deals';
import { panelPublicRoutes } from './routes/panelPublic';
import { adminPublicRoutes } from './routes/adminPublic';
import { startNotificationJobs } from './jobs/notificationJobs';
import { requestLogger, logger } from './utils/logger';


export { prisma };
const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// ── Middleware ──
// CORS: Allow all origins (mobile devices use different IPs, Expo dev uses various ports)
app.use(cors({
  origin: true, // allow all origins (restrict in production via env var)
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
}));
app.use(express.json());

// Structured request logging
app.use(requestLogger());

// ── Static: Admin ve Merchant panelleri ──
app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin-panel.html'));
});
app.get('/merchant', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'merchant-panel.html'));
});

// ── Rate Limiting ──
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/cities', generalLimiter, cityRoutes);

// ── User Routes ──
app.use('/api/merchants', generalLimiter, merchantRoutes);
app.use('/api/gift-cards', paymentLimiter, giftCardRoutes);
app.use('/api/redeem', paymentLimiter, redemptionRoutes);
app.use('/api/tokens', paymentLimiter, tokenRoutes);
app.use('/api/topup', paymentLimiter, topupRoutes);
app.use('/api/referral', generalLimiter, referralRoutes);
app.use('/api/mystery-tasks', generalLimiter, mysteryTaskRoutes);
app.use('/api/notifications', generalLimiter, notificationRoutes);
app.use('/api/connections', generalLimiter, connectionRoutes);
app.use('/api/groups', generalLimiter, groupRoutes);
app.use('/api/nearby', generalLimiter, nearbyRoutes);
app.use('/api/jobs', generalLimiter, jobsRoutes);
app.use('/api/deals', paymentLimiter, dealsRoutes);

// ── Payment Routes (iyzico) ──
app.use('/api/payment', paymentLimiter, iyzicoRoutes);

// ── Admin Routes ──
app.use('/api/admin', adminLimiter, adminRoutes);

// ── Merchant Panel Routes ──
app.use('/api/merchant-panel', adminLimiter, merchantPanelRoutes);

// ── Settlement Routes (internal) ──
app.use('/api/settlements', adminLimiter, settlementRoutes);

// ── Batch Settlement Routes (admin — daily batch payments) ──
app.use('/api/batch-settlements', adminLimiter, batchSettlementRoutes);

// ── Public Panel Data (merchant panel HTML — no auth) ──
app.use('/api/panel', generalLimiter, panelPublicRoutes);
app.use('/api/admin-public', generalLimiter, adminPublicRoutes);

// ── Health check ──
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'vita-backend',
    version: '1.0.0',
    modules: ['syylyq', 'medime', 'denetle'],
    timestamp: new Date().toISOString(),
  });
});

// ── Background Jobs ──
startNotificationJobs(prisma);

// ── Server başlat ──
app.listen(PORT, '0.0.0.0', () => {
  logger.info('Server started', {
    port: PORT,
    api: `http://localhost:${PORT}/api`,
    admin: `http://localhost:${PORT}/admin`,
    merchant: `http://localhost:${PORT}/merchant`,
    modules: ['syylyq', 'medime', 'denetle'],
  });
  console.log(`
╔═══════════════════════════════════════════════╗
║        🚀 VITA Backend v1.0.0                ║
╠═══════════════════════════════════════════════╣
║  API:       http://localhost:${PORT}              ║
║  Health:    http://localhost:${PORT}/api/health    ║
║  Admin:     http://localhost:${PORT}/admin         ║
║  Merchant:  http://localhost:${PORT}/merchant      ║
╠═══════════════════════════════════════════════╣
║  Modüller: Jest · NearbyMe · Gözlemle         ║
║  Yaşa. Gözlemle. Kazanç Sağla.              ║
╚═══════════════════════════════════════════════╝
  `);
});

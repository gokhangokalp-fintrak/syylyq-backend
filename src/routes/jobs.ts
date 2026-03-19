// ─────────────────────────────────────────────────────
// VITA Jobs — Gig Economy / Micro-task Marketplace
// Token payments with escrow for employer budget
// ─────────────────────────────────────────────────────

import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../middleware/auth';
import { createLogger } from '../utils/logger';

const log = createLogger('Jobs');

export const jobsRoutes = Router();

// Cast prisma as any for Prisma client properties
const db = prisma as any;

// ─────────────────────────────────────────────────────
// GET /api/jobs/categories — List all job categories
// ─────────────────────────────────────────────────────
jobsRoutes.get('/categories', async (req, res) => {
  try {
    const categories = await db.jobCategory.findMany({
      orderBy: { name: 'asc' },
    });

    res.json({ categories });
  } catch (err) {
    log.error('Get categories error', err);
    res.status(500).json({ error: 'Kategoriler yüklenemedi' });
  }
});

// ─────────────────────────────────────────────────────
// GET /api/jobs — List jobs with filters
// Query: categoryId, cityId, status, search, page, limit
// ─────────────────────────────────────────────────────
jobsRoutes.get('/', async (req, res) => {
  try {
    const { categoryId, cityId, status = 'open', search, page = '1', limit = '20' } = req.query;
    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit as string) || 20));
    const skip = (pageNum - 1) * limitNum;

    const where: any = {};

    if (status) where.status = status;
    if (categoryId) where.categoryId = categoryId;
    if (cityId) where.cityId = cityId;
    if (search) {
      where.OR = [
        { title: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    const [jobs, total] = await Promise.all([
      db.job.findMany({
        where,
        include: {
          category: true,
          employer: {
            select: { id: true, name: true, avatarUrl: true, tokenBalance: true },
          },
          applications: {
            select: { id: true },
          },
          _count: {
            select: { applications: true },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
      }),
      db.job.count({ where }),
    ]);

    const formatted = jobs.map((job: any) => ({
      id: job.id,
      title: job.title,
      description: job.description,
      category: job.category,
      employer: job.employer,
      budget: job.budget,
      budgetType: job.budgetType,
      latitude: job.latitude,
      longitude: job.longitude,
      address: job.address,
      cityId: job.cityId,
      status: job.status,
      deadline: job.deadline,
      applicationCount: job._count.applications,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }));

    res.json({
      jobs: formatted,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (err) {
    log.error('Get jobs error', err);
    res.status(500).json({ error: 'İşler yüklenemedi' });
  }
});

// ─────────────────────────────────────────────────────
// POST /api/jobs — Create job
// Requires auth
// ─────────────────────────────────────────────────────
jobsRoutes.post('/', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { title, description, categoryId, budget, budgetType, latitude, longitude, address, cityId, deadline } = req.body;

    if (!title || !description || !categoryId || !budget) {
      return res.status(400).json({ error: 'Başlık, açıklama, kategori ve bütçe gerekli' });
    }

    if (budget <= 0) {
      return res.status(400).json({ error: 'Bütçe pozitif olmalı' });
    }

    // Verify category exists
    const category = await db.jobCategory.findUnique({ where: { id: categoryId } });
    if (!category) {
      return res.status(404).json({ error: 'Kategori bulunamadı' });
    }

    const job = await db.job.create({
      data: {
        title,
        description,
        categoryId,
        employerId: userId,
        budget,
        budgetType: budgetType || 'fixed',
        latitude: latitude ? parseFloat(latitude) : undefined,
        longitude: longitude ? parseFloat(longitude) : undefined,
        address: address || undefined,
        cityId: cityId || undefined,
        deadline: deadline ? new Date(deadline) : undefined,
        status: 'open',
      },
      include: {
        category: true,
        employer: {
          select: { id: true, name: true, avatarUrl: true, tokenBalance: true },
        },
      },
    });

    const employer = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    log.info(`Job created: ${job.title} by ${employer?.name}`);

    res.status(201).json({
      success: true,
      job: {
        id: job.id,
        title: job.title,
        description: job.description,
        category: job.category,
        employer: job.employer,
        budget: job.budget,
        budgetType: job.budgetType,
        latitude: job.latitude,
        longitude: job.longitude,
        address: job.address,
        cityId: job.cityId,
        status: job.status,
        deadline: job.deadline,
        applicationCount: 0,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      },
    });
  } catch (err) {
    log.error('Create job error', err);
    res.status(500).json({ error: 'İş oluşturulamadı' });
  }
});

// ─────────────────────────────────────────────────────
// GET /api/jobs/:id — Job detail
// ─────────────────────────────────────────────────────
jobsRoutes.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.auth?.id;

    const jobDetail = await db.job.findUnique({
      where: { id },
      include: {
        category: true,
        employer: {
          select: { id: true, name: true, avatarUrl: true, tokenBalance: true },
        },
        applications: userId ? {
          include: {
            applicant: {
              select: { id: true, name: true, avatarUrl: true },
            },
          },
        } : false,
        ratings: {
          include: {
            rater: {
              select: { id: true, name: true },
            },
            rated: {
              select: { id: true, name: true },
            },
          },
        },
        _count: {
          select: { applications: true },
        },
      },
    });

    if (!jobDetail) {
      return res.status(404).json({ error: 'İş bulunamadı' });
    }

    // If not employer, don't include applications detail
    const isEmployer = userId === jobDetail.employerId;
    const applications = isEmployer ? jobDetail.applications : undefined;

    res.json({
      job: {
        id: jobDetail.id,
        title: jobDetail.title,
        description: jobDetail.description,
        category: jobDetail.category,
        employer: jobDetail.employer,
        budget: jobDetail.budget,
        budgetType: jobDetail.budgetType,
        latitude: jobDetail.latitude,
        longitude: jobDetail.longitude,
        address: jobDetail.address,
        cityId: jobDetail.cityId,
        status: jobDetail.status,
        deadline: jobDetail.deadline,
        applicationCount: jobDetail._count.applications,
        applications: isEmployer ? applications : undefined,
        ratings: jobDetail.ratings,
        createdAt: jobDetail.createdAt,
        updatedAt: jobDetail.updatedAt,
      },
    });
  } catch (err) {
    log.error('Get job detail error', err);
    res.status(500).json({ error: 'İş detayı yüklenemedi' });
  }
});

// ─────────────────────────────────────────────────────
// GET /api/jobs/my/all — My posted jobs + my applications
// Requires auth
// ─────────────────────────────────────────────────────
jobsRoutes.get('/my/all', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id;

    const [posted, applied] = await Promise.all([
      db.job.findMany({
        where: { employerId: userId },
        include: {
          category: true,
          employer: {
            select: { id: true, name: true, avatarUrl: true, tokenBalance: true },
          },
          _count: {
            select: { applications: true },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      db.jobApplication.findMany({
        where: { applicantId: userId },
        include: {
          job: {
            include: {
              category: true,
              employer: {
                select: { id: true, name: true, avatarUrl: true, tokenBalance: true },
              },
              _count: {
                select: { applications: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    const formattedPosted = posted.map((jobItem: any) => ({
      id: jobItem.id,
      title: jobItem.title,
      description: jobItem.description,
      category: jobItem.category,
      employer: jobItem.employer,
      budget: jobItem.budget,
      budgetType: jobItem.budgetType,
      latitude: jobItem.latitude,
      longitude: jobItem.longitude,
      address: jobItem.address,
      cityId: jobItem.cityId,
      status: jobItem.status,
      deadline: jobItem.deadline,
      applicationCount: jobItem._count.applications,
      createdAt: jobItem.createdAt,
      updatedAt: jobItem.updatedAt,
    }));

    const formattedApplied = applied.map((app: any) => ({
      id: app.id,
      jobId: app.jobId,
      job: {
        id: app.job.id,
        title: app.job.title,
        description: app.job.description,
        category: app.job.category,
        employer: app.job.employer,
        budget: app.job.budget,
        budgetType: app.job.budgetType,
        latitude: app.job.latitude,
        longitude: app.job.longitude,
        address: app.job.address,
        cityId: app.job.cityId,
        status: app.job.status,
        deadline: app.job.deadline,
        applicationCount: app.job._count.applications,
        createdAt: app.job.createdAt,
        updatedAt: app.job.updatedAt,
      },
      message: app.message,
      priceOffer: app.priceOffer,
      status: app.status,
      createdAt: app.createdAt,
      updatedAt: app.updatedAt,
    }));

    res.json({
      posted: formattedPosted,
      applied: formattedApplied,
    });
  } catch (err) {
    log.error('Get my jobs error', err);
    res.status(500).json({ error: 'İşler yüklenemedi' });
  }
});

// ─────────────────────────────────────────────────────
// POST /api/jobs/:id/apply — Apply to job
// Requires auth
// Body: { message?, priceOffer? }
// ─────────────────────────────────────────────────────
jobsRoutes.post('/:id/apply', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { id } = req.params;
    const { message, priceOffer } = req.body;

    const jobDetail = await db.job.findUnique({ where: { id } });
    if (!jobDetail) {
      return res.status(404).json({ error: 'İş bulunamadı' });
    }

    // Can't apply to own job
    if (jobDetail.employerId === userId) {
      return res.status(400).json({ error: 'Kendi işine başvuramazsın' });
    }

    // Can't apply if job is not open
    if (jobDetail.status !== 'open') {
      return res.status(400).json({ error: 'Bu iş artık açık değil' });
    }

    // Check for existing application
    const existing = await db.jobApplication.findFirst({
      where: { jobId: id, applicantId: userId },
    });

    if (existing) {
      return res.status(400).json({ error: 'Bu işe zaten başvurdun' });
    }

    const application = await db.jobApplication.create({
      data: {
        jobId: id,
        applicantId: userId,
        message: message || null,
        priceOffer: priceOffer ? parseInt(priceOffer) : null,
      },
      include: {
        applicant: {
          select: { id: true, name: true, avatarUrl: true },
        },
      },
    });

    const applicant = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
    log.info(`Application: ${applicant?.name} → Job ${jobDetail.title}`);

    res.status(201).json({
      success: true,
      application: {
        id: application.id,
        jobId: application.jobId,
        applicant: application.applicant,
        message: application.message,
        priceOffer: application.priceOffer,
        status: application.status,
        createdAt: application.createdAt,
      },
    });
  } catch (err) {
    log.error('Apply error', err);
    res.status(500).json({ error: 'Başvuru gönderilemedi' });
  }
});

// ─────────────────────────────────────────────────────
// PUT /api/jobs/:id/accept/:applicationId
// Accept application & lock budget in escrow
// Requires auth (employer only)
// ─────────────────────────────────────────────────────
jobsRoutes.put('/:id/accept/:applicationId', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { id, applicationId } = req.params;

    const jobDetail = await db.job.findUnique({ where: { id } });
    if (!jobDetail) {
      return res.status(404).json({ error: 'İş bulunamadı' });
    }

    // Only employer can accept
    if (jobDetail.employerId !== userId) {
      return res.status(403).json({ error: 'Sadece işveren kabul edebilir' });
    }

    const application = await db.jobApplication.findUnique({
      where: { id: applicationId },
      include: { applicant: { select: { id: true, name: true } } },
    });

    if (!application) {
      return res.status(404).json({ error: 'Başvuru bulunamadı' });
    }

    if (application.jobId !== id) {
      return res.status(400).json({ error: 'Başvuru bu işe ait değil' });
    }

    // Check employer token balance
    const employer = await prisma.user.findUnique({ where: { id: userId } });
    if (!employer) {
      return res.status(404).json({ error: 'İşveren bulunamadı' });
    }

    if (employer.tokenBalance < jobDetail.budget) {
      return res.status(400).json({ error: 'Yetersiz token bakiyesi. Bütçeyi kilitleyemezsin.' });
    }

    // Atomic transaction
    const result = await prisma.$transaction(async (tx: any) => {
      // Accept this application
      const updatedApp = await tx.jobApplication.update({
        where: { id: applicationId },
        data: { status: 'accepted' },
      });

      // Reject all other applications
      await tx.jobApplication.updateMany({
        where: {
          jobId: id,
          id: { not: applicationId },
          status: { not: 'rejected' },
        },
        data: { status: 'rejected' },
      });

      // Update job status
      const updatedJob = await tx.job.update({
        where: { id },
        data: { status: 'in_progress' },
      });

      // Deduct budget from employer (lock in escrow)
      await tx.user.update({
        where: { id: userId },
        data: { tokenBalance: { decrement: jobDetail.budget } },
      });

      // Log transaction
      const newBalance = employer.tokenBalance - jobDetail.budget;
      await tx.tokenTransaction.create({
        data: {
          userId,
          amount: -jobDetail.budget,
          type: 'spend_purchase',
          source: `İş Bütçesi Kilidi — ${application.applicant.name}`,
          isCashable: false,
          balanceAfter: newBalance,
          relatedId: id,
        },
      });

      return { updatedApp, updatedJob, newBalance };
    });

    log.info(`Application accepted: ${application.applicant.name} for job ${jobDetail.title}`);

    res.json({
      success: true,
      job: result.updatedJob,
      application: result.updatedApp,
      employerNewBalance: result.newBalance,
    });
  } catch (err) {
    log.error('Accept application error', err);
    res.status(500).json({ error: 'Başvuru kabul edilemedi' });
  }
});

// ─────────────────────────────────────────────────────
// PUT /api/jobs/:id/complete
// Mark job as complete, transfer tokens to worker
// Requires auth (employer only)
// ─────────────────────────────────────────────────────
jobsRoutes.put('/:id/complete', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { id } = req.params;

    const jobDetail = await db.job.findUnique({
      where: { id },
      include: {
        applications: {
          where: { status: 'accepted' },
          include: { applicant: { select: { id: true, name: true } } },
        },
      },
    });

    if (!jobDetail) {
      return res.status(404).json({ error: 'İş bulunamadı' });
    }

    // Only employer can complete
    if (jobDetail.employerId !== userId) {
      return res.status(403).json({ error: 'Sadece işveren tamamlayabilir' });
    }

    if (jobDetail.status !== 'in_progress') {
      return res.status(400).json({ error: 'İş devam etmekte değil' });
    }

    const acceptedApp = jobDetail.applications[0];
    if (!acceptedApp) {
      return res.status(400).json({ error: 'Kabul edilen başvuru bulunamadı' });
    }

    const workerId = acceptedApp.applicant.id;
    const workerName = acceptedApp.applicant.name;

    // Atomic transaction
    const result = await prisma.$transaction(async (tx: any) => {
      // Update job status
      const updatedJob = await tx.job.update({
        where: { id },
        data: { status: 'completed' },
      });

      // Transfer tokens to worker
      const worker = await tx.user.findUnique({ where: { id: workerId } });
      const newWorkerBalance = (worker?.tokenBalance || 0) + jobDetail.budget;

      await tx.user.update({
        where: { id: workerId },
        data: { tokenBalance: { increment: jobDetail.budget } },
      });

      // Log transactions
      await tx.tokenTransaction.create({
        data: {
          userId: workerId,
          amount: jobDetail.budget,
          type: 'earn_activity',
          source: `İş Tamamlama Ödülü — ${jobDetail.title}`,
          isCashable: true,
          balanceAfter: newWorkerBalance,
          relatedId: id,
        },
      });

      return { updatedJob, newWorkerBalance };
    });

    log.info(`Job completed: ${jobDetail.title}, ${jobDetail.budget} tokens → ${workerName}`);

    res.json({
      success: true,
      job: result.updatedJob,
      workerNewBalance: result.newWorkerBalance,
    });
  } catch (err) {
    log.error('Complete job error', err);
    res.status(500).json({ error: 'İş tamamlanamadı' });
  }
});

// ─────────────────────────────────────────────────────
// POST /api/jobs/:id/rate
// Rate the other party (employer or worker)
// Requires auth
// Body: { score (1-5), comment? }
// ─────────────────────────────────────────────────────
jobsRoutes.post('/:id/rate', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { id } = req.params;
    const { score, comment } = req.body;

    if (!score || score < 1 || score > 5) {
      return res.status(400).json({ error: 'Puan 1-5 arasında olmalı' });
    }

    const jobDetail = await db.job.findUnique({
      where: { id },
      include: {
        applications: {
          where: { status: 'accepted' },
          include: { applicant: { select: { id: true } } },
        },
      },
    });

    if (!jobDetail) {
      return res.status(404).json({ error: 'İş bulunamadı' });
    }

    if (jobDetail.status !== 'completed') {
      return res.status(400).json({ error: 'Sadece tamamlanan işler puanlandırabilir' });
    }

    const acceptedApp = jobDetail.applications[0];
    if (!acceptedApp) {
      return res.status(400).json({ error: 'Kabul edilen başvuru bulunamadı' });
    }

    const workerId = acceptedApp.applicant.id;
    const isEmployer = userId === jobDetail.employerId;
    const isWorker = userId === workerId;

    if (!isEmployer && !isWorker) {
      return res.status(403).json({ error: 'Bu işi puanlandırma yetkisi yok' });
    }

    // Determine rater and rated
    const raterId = userId;
    const ratedId = isEmployer ? workerId : jobDetail.employerId;

    // Check if already rated
    const existing = await db.jobRating.findFirst({
      where: { jobId: id, raterId, ratedId },
    });

    if (existing) {
      return res.status(400).json({ error: 'Bu işi zaten puanladın' });
    }

    const rating = await db.jobRating.create({
      data: {
        jobId: id,
        raterId,
        ratedId,
        score,
        comment: comment || null,
      },
      include: {
        rater: { select: { id: true, name: true } },
        rated: { select: { id: true, name: true } },
      },
    });

    log.info(`Rating: ${rating.rater.name} (${score}★) → ${rating.rated.name}`);

    res.status(201).json({
      success: true,
      rating: {
        id: rating.id,
        jobId: rating.jobId,
        rater: rating.rater,
        rated: rating.rated,
        score: rating.score,
        comment: rating.comment,
        createdAt: rating.createdAt,
      },
    });
  } catch (err) {
    log.error('Rate error', err);
    res.status(500).json({ error: 'Puan verilemedi' });
  }
});

// ─────────────────────────────────────────────────────
// PUT /api/jobs/:id/cancel
// Cancel job (employer only, only if still 'open')
// ─────────────────────────────────────────────────────
jobsRoutes.put('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { id } = req.params;

    const jobDetail = await db.job.findUnique({ where: { id } });
    if (!jobDetail) {
      return res.status(404).json({ error: 'İş bulunamadı' });
    }

    // Only employer can cancel
    if (jobDetail.employerId !== userId) {
      return res.status(403).json({ error: 'Sadece işveren iptal edebilir' });
    }

    // Can only cancel if open
    if (jobDetail.status !== 'open') {
      return res.status(400).json({ error: 'Açık olmayan işler iptal edilemez' });
    }

    const updatedJob = await db.job.update({
      where: { id },
      data: { status: 'cancelled' },
    });

    log.info(`Job cancelled: ${jobDetail.title}`);

    res.json({
      success: true,
      job: updatedJob,
    });
  } catch (err) {
    log.error('Cancel job error', err);
    res.status(500).json({ error: 'İş iptal edilemedi' });
  }
});

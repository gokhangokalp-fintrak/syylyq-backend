import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAuth, requireMerchant } from '../middleware/auth';
import crypto from 'crypto';

export const dealsRoutes = Router();

// ============================================================================
// USER ENDPOINTS
// ============================================================================

/**
 * GET / - List active deals with optional filters
 * Query params: category, cityId, search, sort (asc|desc), page, limit
 */
dealsRoutes.get('/', async (req, res) => {
  try {
    const {
      category,
      cityId,
      search,
      sort = 'desc',
      page = '1',
      limit = '20'
    } = req.query;

    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.min(100, parseInt(limit as string) || 20);
    const skip = (pageNum - 1) * limitNum;

    // Build where clause
    const where: any = {
      isActive: true,
      endDate: { gt: new Date() }
    };

    if (category && category !== '') {
      where.category = category;
    }

    if (cityId && cityId !== '') {
      where.cityId = parseInt(cityId as string);
    }

    if (search && search !== '') {
      where.OR = [
        { title: { contains: search as string, mode: 'insensitive' } },
        { description: { contains: search as string, mode: 'insensitive' } }
      ];
    }

    // Fetch deals and total count
    const [deals, total] = await Promise.all([
      prisma.deal.findMany({
        where,
        orderBy: {
          createdAt: sort === 'asc' ? 'asc' : 'desc'
        },
        skip,
        take: limitNum,
        select: {
          id: true,
          merchantId: true,
          title: true,
          description: true,
          category: true,
          imageUrl: true,
          originalPrice: true,
          discountedPrice: true,
          discountRate: true,
          minParticipants: true,
          maxParticipants: true,
          currentCount: true,
          isActivated: true,
          startDate: true,
          endDate: true,
          viewCount: true,
          maxPerUser: true,
          totalUsages: true,
          acceptToken: true,
          hybridAllowed: true,
          tokenPrice: true,
          latitude: true,
          longitude: true,
          address: true,
          cityId: true,
          createdAt: true
        }
      }),
      prisma.deal.count({ where })
    ]);

    res.json({
      success: true,
      data: deals,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('Error fetching deals:', error);
    res.status(500).json({ success: false, message: 'Dealler yüklenirken hata oluştu' });
  }
});

/**
 * GET /:dealId - Get deal detail and increment viewCount
 */
dealsRoutes.get('/:dealId', async (req, res) => {
  try {
    const { dealId } = req.params;

    // Fetch deal
    const deal = await prisma.deal.findUnique({
      where: { id: dealId },
      select: {
        id: true,
        merchantId: true,
        title: true,
        description: true,
        category: true,
        imageUrl: true,
        images: true,
        originalPrice: true,
        discountedPrice: true,
        discountRate: true,
        minParticipants: true,
        maxParticipants: true,
        currentCount: true,
        isActivated: true,
        startDate: true,
        endDate: true,
        isActive: true,
        viewCount: true,
        maxPerUser: true,
        totalUsages: true,
        acceptToken: true,
        hybridAllowed: true,
        tokenPrice: true,
        latitude: true,
        longitude: true,
        address: true,
        cityId: true,
        createdAt: true
      }
    });

    if (!deal) {
      return res.status(404).json({ success: false, message: 'Deal bulunamadı' });
    }

    // Increment viewCount
    await prisma.deal.update({
      where: { id: dealId },
      data: { viewCount: { increment: 1 } }
    });

    // Return deal with updated viewCount
    const updatedDeal = { ...deal, viewCount: deal.viewCount + 1 };

    res.json({
      success: true,
      data: updatedDeal
    });
  } catch (error) {
    console.error('Error fetching deal detail:', error);
    res.status(500).json({ success: false, message: 'Deal detayı yüklenirken hata oluştu' });
  }
});

/**
 * POST /:dealId/purchase - Purchase a deal
 * Body: { paymentMethod: 'cash'|'token'|'hybrid', tokenAmount?: number }
 */
dealsRoutes.post('/:dealId/purchase', requireAuth, async (req, res) => {
  try {
    const { dealId } = req.params;
    const { paymentMethod, tokenAmount } = req.body;
    const userId = req.auth!.id;

    // Validate payment method
    if (!['cash', 'token', 'hybrid'].includes(paymentMethod)) {
      return res.status(400).json({ success: false, message: 'Geçersiz ödeme yöntemi' });
    }

    // Fetch deal
    const deal = await prisma.deal.findUnique({ where: { id: dealId } });

    if (!deal) {
      return res.status(404).json({ success: false, message: 'Deal bulunamadı' });
    }

    // Validate deal is active
    if (!deal.isActive) {
      return res.status(400).json({ success: false, message: 'Bu deal artık aktif değil' });
    }

    // Validate deal hasn't expired
    if (deal.endDate < new Date()) {
      return res.status(400).json({ success: false, message: 'Süresi dolmuş' });
    }

    // Validate stock available
    if (deal.currentCount >= deal.maxParticipants) {
      return res.status(400).json({ success: false, message: 'Stok tükendi' });
    }

    // Check user's purchase count for this deal
    const userPurchaseCount = await prisma.dealPurchase.count({
      where: { userId, dealId, status: { in: ['active', 'used'] } }
    });

    if (userPurchaseCount >= deal.maxPerUser) {
      return res.status(400).json({ success: false, message: 'Maksimum satın alma limitine ulaştınız' });
    }

    // Handle token payment
    let tokensPaid = 0;
    let cashAmount = 0;

    if (paymentMethod === 'token' || paymentMethod === 'hybrid') {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { tokenBalance: true }
      });

      if (!user) {
        return res.status(404).json({ success: false, message: 'Kullanıcı bulunamadı' });
      }

      const tokensNeeded = paymentMethod === 'token'
        ? deal.tokenPrice
        : tokenAmount || 0;

      if (tokensNeeded > user.tokenBalance) {
        return res.status(400).json({ success: false, message: 'Yetersiz token bakiyesi' });
      }

      // Deduct tokens
      await prisma.user.update({
        where: { id: userId },
        data: { tokenBalance: { decrement: tokensNeeded } }
      });

      tokensPaid = tokensNeeded;
    }

    if (paymentMethod === 'cash' || paymentMethod === 'hybrid') {
      cashAmount = paymentMethod === 'cash'
        ? deal.discountedPrice
        : deal.discountedPrice - (tokenAmount ? (tokenAmount * 100) : 0); // tokenAmount in TRY
    }

    // Generate unique QR code
    const qrCode = `DEAL-${dealId.substring(0, 6)}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

    // Generate QR data
    const qrData = JSON.stringify({
      purchaseId: '', // Will be set after purchase creation
      dealId,
      userId,
      qrCode,
      totalUsages: deal.totalUsages,
      createdAt: new Date().toISOString()
    });

    // Create purchase
    const purchase = await prisma.dealPurchase.create({
      data: {
        dealId,
        userId,
        paidAmount: cashAmount,
        paidTokens: tokensPaid,
        paymentMethod: paymentMethod as 'cash' | 'token' | 'hybrid',
        qrCode,
        qrData: JSON.stringify({
          purchaseId: '', // Placeholder
          dealId,
          userId,
          qrCode,
          totalUsages: deal.totalUsages,
          createdAt: new Date().toISOString()
        }),
        totalUsages: deal.totalUsages,
        usedCount: 0,
        status: 'active',
        expiresAt: deal.endDate
      }
    });

    // Update qrData with actual purchaseId
    const updatedQrData = JSON.stringify({
      purchaseId: purchase.id,
      dealId,
      userId,
      qrCode,
      totalUsages: deal.totalUsages,
      createdAt: purchase.createdAt.toISOString()
    });

    await prisma.dealPurchase.update({
      where: { id: purchase.id },
      data: { qrData: updatedQrData }
    });

    // Increment deal.currentCount
    const updatedDeal = await prisma.deal.update({
      where: { id: dealId },
      data: { currentCount: { increment: 1 } }
    });

    // Check if minParticipants reached
    if (updatedDeal.currentCount >= updatedDeal.minParticipants && !updatedDeal.isActivated) {
      await prisma.deal.update({
        where: { id: dealId },
        data: { isActivated: true }
      });
    }

    // Return purchase with qrCode
    const purchaseResponse = await prisma.dealPurchase.findUnique({
      where: { id: purchase.id },
      select: {
        id: true,
        dealId: true,
        userId: true,
        paidAmount: true,
        paidTokens: true,
        paymentMethod: true,
        qrCode: true,
        qrData: true,
        totalUsages: true,
        usedCount: true,
        status: true,
        lastUsedAt: true,
        createdAt: true,
        expiresAt: true
      }
    });

    res.status(201).json({
      success: true,
      data: purchaseResponse,
      message: 'Deal başarıyla satın alındı'
    });
  } catch (error) {
    console.error('Error purchasing deal:', error);
    res.status(500).json({ success: false, message: 'Deal satın alınırken hata oluştu' });
  }
});

/**
 * GET /my/purchases - List user's deal purchases with optional status filter
 */
dealsRoutes.get('/my/purchases', requireAuth, async (req, res) => {
  try {
    const userId = req.auth!.id;
    const { status, page = '1', limit = '20' } = req.query;

    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.min(100, parseInt(limit as string) || 20);
    const skip = (pageNum - 1) * limitNum;

    // Build where clause
    const where: any = { userId };

    if (status && status !== '') {
      where.status = status;
    }

    // Fetch purchases and total count
    const [purchases, total] = await Promise.all([
      prisma.dealPurchase.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
        include: {
          deal: {
            select: {
              id: true,
              title: true,
              description: true,
              imageUrl: true,
              discountedPrice: true,
              totalUsages: true,
              endDate: true
            }
          }
        }
      }),
      prisma.dealPurchase.count({ where })
    ]);

    res.json({
      success: true,
      data: purchases,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('Error fetching user purchases:', error);
    res.status(500).json({ success: false, message: 'Satın almalarınız yüklenirken hata oluştu' });
  }
});

/**
 * GET /my/purchases/:purchaseId - Get purchase detail with usage history
 */
dealsRoutes.get('/my/purchases/:purchaseId', requireAuth, async (req, res) => {
  try {
    const { purchaseId } = req.params;
    const userId = req.auth!.id;

    // Fetch purchase and verify ownership
    const purchase = await prisma.dealPurchase.findUnique({
      where: { id: purchaseId },
      include: {
        deal: {
          select: {
            id: true,
            title: true,
            description: true,
            imageUrl: true,
            category: true,
            originalPrice: true,
            discountedPrice: true,
            totalUsages: true,
            endDate: true,
            address: true,
            latitude: true,
            longitude: true
          }
        },
        usages: {
          orderBy: { usedAt: 'desc' },
          select: {
            id: true,
            usedAt: true,
            verifiedBy: true
          }
        }
      }
    });

    if (!purchase) {
      return res.status(404).json({ success: false, message: 'Satın alma bulunamadı' });
    }

    if (purchase.userId !== userId) {
      return res.status(403).json({ success: false, message: 'Bu satın almaya erişim yetkiniz yok' });
    }

    res.json({
      success: true,
      data: purchase
    });
  } catch (error) {
    console.error('Error fetching purchase detail:', error);
    res.status(500).json({ success: false, message: 'Satın alma detayı yüklenirken hata oluştu' });
  }
});

// ============================================================================
// MERCHANT ENDPOINTS
// ============================================================================

/**
 * POST /merchant/create - Create a new deal
 */
dealsRoutes.post('/merchant/create', requireAuth, requireMerchant, async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId;
    const {
      title,
      description,
      category,
      imageUrl,
      images,
      originalPrice,
      discountedPrice,
      minParticipants,
      maxParticipants,
      maxPerUser,
      totalUsages,
      acceptToken,
      hybridAllowed,
      tokenPrice,
      startDate,
      endDate,
      latitude,
      longitude,
      address,
      cityId
    } = req.body;

    // Validate required fields
    if (!title || !description || !category || !originalPrice || !discountedPrice) {
      return res.status(400).json({ success: false, message: 'Gerekli alanları doldurunuz' });
    }

    // Validate prices
    if (discountedPrice >= originalPrice) {
      return res.status(400).json({ success: false, message: 'İndirimli fiyat orijinal fiyattan düşük olmalı' });
    }

    // Calculate discountRate
    const discountRate = Math.round(((originalPrice - discountedPrice) / originalPrice) * 100);

    // Create deal
    const deal = await prisma.deal.create({
      data: {
        merchantId,
        title,
        description,
        category,
        imageUrl: imageUrl || null,
        images: images || [],
        originalPrice: parseInt(originalPrice),
        discountedPrice: parseInt(discountedPrice),
        discountRate,
        minParticipants: parseInt(minParticipants) || 1,
        maxParticipants: parseInt(maxParticipants) || 100,
        currentCount: 0,
        isActivated: false,
        startDate: new Date(startDate),
        endDate: new Date(endDate),
        isActive: true,
        viewCount: 0,
        maxPerUser: parseInt(maxPerUser) || 1,
        totalUsages: parseInt(totalUsages) || 1,
        acceptToken: acceptToken || false,
        hybridAllowed: hybridAllowed || false,
        tokenPrice: acceptToken ? parseInt(tokenPrice) || 0 : 0,
        latitude: latitude ? parseFloat(latitude) : null,
        longitude: longitude ? parseFloat(longitude) : null,
        address: address || null,
        cityId: cityId ? parseInt(cityId) : null
      }
    });

    res.status(201).json({
      success: true,
      data: deal,
      message: 'Deal başarıyla oluşturuldu'
    });
  } catch (error) {
    console.error('Error creating deal:', error);
    res.status(500).json({ success: false, message: 'Deal oluşturulurken hata oluştu' });
  }
});

/**
 * GET /merchant/my-deals - List merchant's deals
 */
dealsRoutes.get('/merchant/my-deals', requireAuth, requireMerchant, async (req, res) => {
  try {
    const merchantId = req.auth!.merchantId;
    const { page = '1', limit = '20' } = req.query;

    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.min(100, parseInt(limit as string) || 20);
    const skip = (pageNum - 1) * limitNum;

    // Fetch merchant's deals and total count
    const [deals, total] = await Promise.all([
      prisma.deal.findMany({
        where: { merchantId },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
        select: {
          id: true,
          merchantId: true,
          title: true,
          description: true,
          category: true,
          imageUrl: true,
          originalPrice: true,
          discountedPrice: true,
          discountRate: true,
          minParticipants: true,
          maxParticipants: true,
          currentCount: true,
          isActivated: true,
          startDate: true,
          endDate: true,
          isActive: true,
          viewCount: true,
          maxPerUser: true,
          totalUsages: true,
          acceptToken: true,
          hybridAllowed: true,
          tokenPrice: true,
          address: true,
          cityId: true,
          createdAt: true
        }
      }),
      prisma.deal.count({ where: { merchantId } })
    ]);

    res.json({
      success: true,
      data: deals,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('Error fetching merchant deals:', error);
    res.status(500).json({ success: false, message: 'Dealler yüklenirken hata oluştu' });
  }
});

/**
 * PUT /merchant/:dealId - Update a deal
 */
dealsRoutes.put('/merchant/:dealId', requireAuth, requireMerchant, async (req, res) => {
  try {
    const { dealId } = req.params;
    const merchantId = req.auth!.merchantId;
    const {
      title,
      description,
      category,
      imageUrl,
      images,
      originalPrice,
      discountedPrice,
      minParticipants,
      maxParticipants,
      maxPerUser,
      totalUsages,
      acceptToken,
      hybridAllowed,
      tokenPrice,
      startDate,
      endDate,
      latitude,
      longitude,
      address,
      cityId,
      isActive
    } = req.body;

    // Fetch deal
    const deal = await prisma.deal.findUnique({ where: { id: dealId } });

    if (!deal) {
      return res.status(404).json({ success: false, message: 'Deal bulunamadı' });
    }

    if (deal.merchantId !== merchantId) {
      return res.status(403).json({ success: false, message: 'Bu deali düzenlemedeki yetkiniz yok' });
    }

    // Build update data
    const updateData: any = {};

    if (title) updateData.title = title;
    if (description) updateData.description = description;
    if (category) updateData.category = category;
    if (imageUrl !== undefined) updateData.imageUrl = imageUrl;
    if (images) updateData.images = images;
    if (minParticipants) updateData.minParticipants = parseInt(minParticipants);
    if (maxParticipants) updateData.maxParticipants = parseInt(maxParticipants);
    if (maxPerUser) updateData.maxPerUser = parseInt(maxPerUser);
    if (totalUsages) updateData.totalUsages = parseInt(totalUsages);
    if (acceptToken !== undefined) updateData.acceptToken = acceptToken;
    if (hybridAllowed !== undefined) updateData.hybridAllowed = hybridAllowed;
    if (tokenPrice !== undefined) updateData.tokenPrice = parseInt(tokenPrice);
    if (startDate) updateData.startDate = new Date(startDate);
    if (endDate) updateData.endDate = new Date(endDate);
    if (latitude !== undefined) updateData.latitude = latitude ? parseFloat(latitude) : null;
    if (longitude !== undefined) updateData.longitude = longitude ? parseFloat(longitude) : null;
    if (address !== undefined) updateData.address = address;
    if (cityId !== undefined) updateData.cityId = cityId ? parseInt(cityId) : null;
    if (isActive !== undefined) updateData.isActive = isActive;

    // Handle price updates with discountRate calculation
    if (originalPrice || discountedPrice) {
      const origPrice = originalPrice ? parseInt(originalPrice) : deal.originalPrice;
      const discPrice = discountedPrice ? parseInt(discountedPrice) : deal.discountedPrice;

      updateData.originalPrice = origPrice;
      updateData.discountedPrice = discPrice;
      updateData.discountRate = Math.round(((origPrice - discPrice) / origPrice) * 100);
    }

    // Update deal
    const updatedDeal = await prisma.deal.update({
      where: { id: dealId },
      data: updateData
    });

    res.json({
      success: true,
      data: updatedDeal,
      message: 'Deal başarıyla güncellendi'
    });
  } catch (error) {
    console.error('Error updating deal:', error);
    res.status(500).json({ success: false, message: 'Deal güncellenirken hata oluştu' });
  }
});

/**
 * GET /merchant/:dealId/stats - Get deal stats
 */
dealsRoutes.get('/merchant/:dealId/stats', requireAuth, requireMerchant, async (req, res) => {
  try {
    const { dealId } = req.params;
    const merchantId = req.auth!.merchantId;

    // Fetch deal
    const deal = await prisma.deal.findUnique({ where: { id: dealId } });

    if (!deal) {
      return res.status(404).json({ success: false, message: 'Deal bulunamadı' });
    }

    if (deal.merchantId !== merchantId) {
      return res.status(403).json({ success: false, message: 'Bu deale erişim yetkiniz yok' });
    }

    // Get purchase stats
    const purchases = await prisma.dealPurchase.findMany({
      where: { dealId },
      select: {
        id: true,
        paidAmount: true,
        paidTokens: true,
        paymentMethod: true,
        status: true,
        usedCount: true,
        createdAt: true
      }
    });

    // Calculate stats
    const totalPurchases = purchases.length;
    const totalRevenueCash = purchases.reduce((sum, p) => sum + (p.paidAmount || 0), 0);
    const totalRevenueTokens = purchases.reduce((sum, p) => sum + (p.paidTokens || 0), 0);
    const activePurchases = purchases.filter(p => p.status === 'active').length;
    const usedPurchases = purchases.filter(p => p.status === 'used').length;
    const totalUsages = purchases.reduce((sum, p) => sum + (p.usedCount || 0), 0);

    // Get usage details
    const usages = await prisma.dealUsage.count({
      where: {
        purchase: { dealId }
      }
    });

    res.json({
      success: true,
      data: {
        deal: {
          id: deal.id,
          title: deal.title,
          currentCount: deal.currentCount,
          maxParticipants: deal.maxParticipants,
          isActivated: deal.isActivated,
          isActive: deal.isActive,
          viewCount: deal.viewCount,
          startDate: deal.startDate,
          endDate: deal.endDate
        },
        purchases: {
          total: totalPurchases,
          active: activePurchases,
          used: usedPurchases
        },
        revenue: {
          cash: totalRevenueCash,
          tokens: totalRevenueTokens
        },
        usages: {
          total: totalUsages,
          count: usages
        }
      }
    });
  } catch (error) {
    console.error('Error fetching deal stats:', error);
    res.status(500).json({ success: false, message: 'İstatistikler yüklenirken hata oluştu' });
  }
});

/**
 * POST /merchant/validate-qr - Validate and use a QR code
 * Body: { qrCode: string }
 */
dealsRoutes.post('/merchant/validate-qr', requireAuth, requireMerchant, async (req, res) => {
  try {
    const { qrCode } = req.body;
    const merchantId = req.auth!.merchantId;

    if (!qrCode) {
      return res.status(400).json({ success: false, message: 'QR kodu gerekli' });
    }

    // Find purchase by qrCode
    const purchase = await prisma.dealPurchase.findUnique({
      where: { qrCode },
      include: { deal: true }
    });

    if (!purchase) {
      return res.status(404).json({ success: false, message: 'Geçersiz QR kodu' });
    }

    // Verify merchant ownership of the deal
    if (purchase.deal.merchantId !== merchantId) {
      return res.status(403).json({ success: false, message: 'Bu kupona erişim yetkiniz yok' });
    }

    // Validate purchase status
    if (purchase.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Bu kupon artık kullanılamaz' });
    }

    // Validate not expired
    if (purchase.expiresAt && purchase.expiresAt < new Date()) {
      return res.status(400).json({ success: false, message: 'Bu kuponun süresi dolmuş' });
    }

    // Validate usage limit
    if (purchase.usedCount >= purchase.totalUsages) {
      return res.status(400).json({ success: false, message: 'Bu kupon tamamen kullanılmış' });
    }

    // Increment usedCount
    const updatedPurchase = await prisma.dealPurchase.update({
      where: { id: purchase.id },
      data: {
        usedCount: { increment: 1 },
        lastUsedAt: new Date(),
        verifiedBy: merchantId,
        status: purchase.usedCount + 1 >= purchase.totalUsages ? 'used' : 'active'
      },
      include: {
        deal: {
          select: {
            id: true,
            title: true,
            discountedPrice: true
          }
        }
      }
    });

    // Create DealUsage record
    const usage = await prisma.dealUsage.create({
      data: {
        purchaseId: purchase.id,
        verifiedBy: merchantId,
        usedAt: new Date()
      }
    });

    // Calculate remaining uses
    const remainingUses = updatedPurchase.totalUsages - updatedPurchase.usedCount;

    res.json({
      success: true,
      data: {
        purchase: {
          id: updatedPurchase.id,
          dealId: updatedPurchase.dealId,
          userId: updatedPurchase.userId,
          qrCode: updatedPurchase.qrCode,
          status: updatedPurchase.status,
          usedCount: updatedPurchase.usedCount,
          totalUsages: updatedPurchase.totalUsages,
          remainingUses,
          lastUsedAt: updatedPurchase.lastUsedAt,
          expiresAt: updatedPurchase.expiresAt
        },
        deal: {
          id: updatedPurchase.deal.id,
          title: updatedPurchase.deal.title,
          discountedPrice: updatedPurchase.deal.discountedPrice
        },
        usage: {
          id: usage.id,
          usedAt: usage.usedAt
        }
      },
      message: 'QR kod başarıyla doğrulandı'
    });
  } catch (error) {
    console.error('Error validating QR code:', error);
    res.status(500).json({ success: false, message: 'QR kod doğrulanırken hata oluştu' });
  }
});

// ============================================================================
// ADMIN ENDPOINTS
// ============================================================================

/**
 * GET /admin/all - List all deals (for admin panel)
 */
dealsRoutes.get('/admin/all', async (req, res) => {
  try {
    const { page = '1', limit = '50' } = req.query;

    const pageNum = Math.max(1, parseInt(page as string) || 1);
    const limitNum = Math.min(100, parseInt(limit as string) || 50);
    const skip = (pageNum - 1) * limitNum;

    // Fetch all deals and total count
    const [deals, total] = await Promise.all([
      prisma.deal.findMany({
        orderBy: { createdAt: 'desc' },
        skip,
        take: limitNum,
        select: {
          id: true,
          merchantId: true,
          title: true,
          description: true,
          category: true,
          imageUrl: true,
          originalPrice: true,
          discountedPrice: true,
          discountRate: true,
          minParticipants: true,
          maxParticipants: true,
          currentCount: true,
          isActivated: true,
          startDate: true,
          endDate: true,
          isActive: true,
          viewCount: true,
          maxPerUser: true,
          totalUsages: true,
          acceptToken: true,
          hybridAllowed: true,
          tokenPrice: true,
          address: true,
          cityId: true,
          createdAt: true
        }
      }),
      prisma.deal.count()
    ]);

    res.json({
      success: true,
      data: deals,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    console.error('Error fetching admin deals:', error);
    res.status(500).json({ success: false, message: 'Dealler yüklenirken hata oluştu' });
  }
});

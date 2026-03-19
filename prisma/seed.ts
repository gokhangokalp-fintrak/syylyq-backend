import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...\n');

  // ══════════════════════════════════════
  // CLEANUP — Temiz başlangıç (sıra: foreign key bağımlılıklarına göre)
  // ══════════════════════════════════════
  console.log('🗑️  Cleaning existing data...');
  // NearbyMe
  await (prisma as any).nearbyMessage.deleteMany();
  await (prisma as any).nearbyMatch.deleteMany();
  await (prisma as any).userLocation.deleteMany();
  // Jobs
  await (prisma as any).jobRating.deleteMany();
  await (prisma as any).jobApplication.deleteMany();
  await (prisma as any).job.deleteMany();
  await (prisma as any).jobCategory.deleteMany();
  // Groups
  await (prisma as any).groupParticipant.deleteMany();
  await (prisma as any).groupGift.deleteMany();
  // Mystery
  await (prisma as any).mysteryTaskCompletion.deleteMany();
  await (prisma as any).mysteryTask.deleteMany();
  await (prisma as any).mysteryBoxReward.deleteMany();
  // Notifications
  await prisma.notification.deleteMany();
  // Connections
  await (prisma as any).userConnection.deleteMany();
  // Leaderboard
  await (prisma as any).leaderboardEntry.deleteMany();
  // Tokens & payments
  await (prisma as any).tokenCashout.deleteMany();
  await (prisma as any).topUpOrder.deleteMany();
  await (prisma as any).tokenRedemption.deleteMany();
  await prisma.tokenTransaction.deleteMany();
  // GiftCard dependents first
  await (prisma as any).giftCardConversion.deleteMany();
  await (prisma as any).giftCardRedemption.deleteMany();
  // Settlements
  await (prisma as any).ledgerEntry.deleteMany();
  await (prisma as any).batchSettlement.deleteMany();
  await (prisma as any).settlement.deleteMany();
  // Now GiftCard itself
  await prisma.giftCard.deleteMany();
  await prisma.referral.deleteMany();
  await prisma.merchantUser.deleteMany();
  await prisma.cardTemplate.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.influencerCode.deleteMany();
  await prisma.merchant.deleteMany();
  await prisma.user.deleteMany();
  await prisma.city.deleteMany();
  console.log('✅ Existing data cleaned\n');

  // ══════════════════════════════════════
  // CITIES (Turkey)
  // ══════════════════════════════════════
  const cities = await Promise.all([
    prisma.city.create({ data: { name: 'İstanbul', nameEn: 'Istanbul', region: 'Marmara Bölgesi', latitude: 41.0082, longitude: 28.9784, sortOrder: 1 } }),
    prisma.city.create({ data: { name: 'Ankara', nameEn: 'Ankara', region: 'İç Anadolu Bölgesi', latitude: 39.9334, longitude: 32.8597, sortOrder: 2 } }),
    prisma.city.create({ data: { name: 'İzmir', nameEn: 'Izmir', region: 'Ege Bölgesi', latitude: 38.4237, longitude: 27.1428, sortOrder: 3 } }),
    prisma.city.create({ data: { name: 'Antalya', nameEn: 'Antalya', region: 'Akdeniz Bölgesi', latitude: 36.8969, longitude: 30.7133, sortOrder: 4 } }),
    prisma.city.create({ data: { name: 'Bursa', nameEn: 'Bursa', region: 'Marmara Bölgesi', latitude: 40.1885, longitude: 29.0610, sortOrder: 5 } }),
    prisma.city.create({ data: { name: 'Eskişehir', nameEn: 'Eskisehir', region: 'İç Anadolu Bölgesi', latitude: 39.7767, longitude: 30.5206, sortOrder: 6 } }),
    prisma.city.create({ data: { name: 'Gaziantep', nameEn: 'Gaziantep', region: 'Güneydoğu Anadolu Bölgesi', latitude: 37.0662, longitude: 37.3833, sortOrder: 7 } }),
    prisma.city.create({ data: { name: 'Konya', nameEn: 'Konya', region: 'İç Anadolu Bölgesi', latitude: 37.8746, longitude: 32.4932, sortOrder: 8 } }),
    prisma.city.create({ data: { name: 'Mersin', nameEn: 'Mersin', region: 'Akdeniz Bölgesi', latitude: 36.8121, longitude: 34.6415, sortOrder: 9 } }),
    prisma.city.create({ data: { name: 'Adana', nameEn: 'Adana', region: 'Akdeniz Bölgesi', latitude: 37.0000, longitude: 35.3213, sortOrder: 10 } }),
  ]);

  const [istanbul, ankara, izmir, antalya, bursa] = cities;
  console.log(`✅ ${cities.length} cities created`);

  // ══════════════════════════════════════
  // MERCHANTS
  // ══════════════════════════════════════
  const merchants = await Promise.all([
    // Nationwide chains
    prisma.merchant.create({
      data: {
        name: 'Kahve Dünyası', description: 'Türkiye\'nin en popüler kahve zinciri',
        category: 'restaurant', commissionRate: 0.07, rating: 4.8,
        isPartner: true, isNationwide: true, approvalStatus: 'approved',
        settlementMethod: 'banka', bankAccount: 'TR001234567890',
        binIin: '123456789012', contactPhone: '+905010000001',
      },
    }),
    prisma.merchant.create({
      data: {
        name: 'Teknosa', description: 'Türkiye\'nin en büyük elektronik mağazaları',
        category: 'electronics', commissionRate: 0.05, rating: 4.5,
        isPartner: true, isNationwide: true, approvalStatus: 'approved',
        settlementMethod: 'sipay', bankAccount: 'TR009876543210',
        binIin: '987654321098', contactPhone: '+905010000002',
      },
    }),
    prisma.merchant.create({
      data: {
        name: 'MAC Center', description: 'Spor ve fitness ekipmanları',
        category: 'sport', commissionRate: 0.06, rating: 4.3,
        isPartner: false, isNationwide: true, approvalStatus: 'approved',
        settlementMethod: 'banka', bankAccount: 'TR005555555555',
        binIin: '555555555555', contactPhone: '+905010000003',
      },
    }),
    // İstanbul only
    prisma.merchant.create({
      data: {
        name: 'Bali Spa', description: 'Lüks spa ve wellness merkezi',
        category: 'spa', commissionRate: 0.08, rating: 4.9,
        isPartner: true, isNationwide: false, approvalStatus: 'approved',
        settlementMethod: 'banka', bankAccount: 'TR002222222222',
        binIin: '222222222222', contactPhone: '+905010000004',
      },
    }),
    prisma.merchant.create({
      data: {
        name: 'LC Waikiki', description: 'Türkiye\'nin popüler moda markası',
        category: 'mall', commissionRate: 0.06, rating: 4.7,
        isPartner: true, isNationwide: false, approvalStatus: 'approved',
        settlementMethod: 'sipay', bankAccount: 'TR003333333333',
        binIin: '333333333333', contactPhone: '+905010000005',
      },
    }),
    // İstanbul + Ankara
    prisma.merchant.create({
      data: {
        name: 'Acıbadem Hastanesi', description: 'Türkiye\'nin önde gelen hastane zinciri',
        category: 'clinic', commissionRate: 0.04, rating: 4.6,
        isPartner: true, isNationwide: false, approvalStatus: 'approved',
        settlementMethod: 'sipay', bankAccount: 'TR004444444444',
        binIin: '444444444444', contactPhone: '+905010000006',
      },
    }),
    // Ankara only
    prisma.merchant.create({
      data: {
        name: 'Big Chef\'s', description: 'Modern Türk mutfağı restoranı',
        category: 'restaurant', commissionRate: 0.07, rating: 4.4,
        isPartner: false, isNationwide: false, approvalStatus: 'approved',
        settlementMethod: 'banka', bankAccount: 'TR006666666666',
        binIin: '666666666666', contactPhone: '+905010000007',
      },
    }),
    // Pending approval
    prisma.merchant.create({
      data: {
        name: 'Happy Moon\'s', description: 'Yeni açılan kafe - onay bekleniyor',
        category: 'restaurant', commissionRate: 0.07, rating: 0,
        isPartner: false, isNationwide: false, approvalStatus: 'pending',
        contactPhone: '+905010000008',
      },
    }),
  ]);

  const [kahveDunyasi, teknosa, macCenter, baliSpa, lcWaikiki, acibadem, bigChefs] = merchants;
  console.log(`✅ ${merchants.length} merchants created`);

  // ══════════════════════════════════════
  // BRANCHES
  // ══════════════════════════════════════
  const branchData = [
    // Kahve Dünyası — nationwide
    { merchantId: kahveDunyasi.id, cityId: istanbul.id, name: 'Kahve Dünyası — Bağdat Caddesi', address: 'Bağdat Caddesi 89, Kadıköy' },
    { merchantId: kahveDunyasi.id, cityId: istanbul.id, name: 'Kahve Dünyası — Taksim', address: 'Taksim Meydanı 52, Beyoğlu' },
    { merchantId: kahveDunyasi.id, cityId: ankara.id, name: 'Kahve Dünyası — Tunalı', address: 'Tunalı Hilmi Caddesi, Çankaya' },
    { merchantId: kahveDunyasi.id, cityId: izmir.id, name: 'Kahve Dünyası — Alsancak', address: 'Alsancak Mahallesi 12, İzmir' },
    // Teknosa — nationwide
    { merchantId: teknosa.id, cityId: istanbul.id, name: 'Teknosa — Forum', address: 'Forum AVM, Bayrampaşa' },
    { merchantId: teknosa.id, cityId: ankara.id, name: 'Teknosa — Çankırı Caddesi', address: 'Çankırı Caddesi AVM, Ankara' },
    { merchantId: teknosa.id, cityId: bursa.id, name: 'Teknosa — Bursa', address: 'Zafer Mahallesi 33, Bursa' },
    // MAC Center — nationwide
    { merchantId: macCenter.id, cityId: istanbul.id, name: 'MAC Center — Ataköy', address: 'Ataköy Spor Kompleksi' },
    { merchantId: macCenter.id, cityId: ankara.id, name: 'MAC Center — Ankara', address: 'Sary Arka AVM, Ankara' },
    // Bali Spa — İstanbul only
    { merchantId: baliSpa.id, cityId: istanbul.id, name: 'Bali Spa — Beşiktaş', address: 'Beşiktaş Sahil Yolu 480' },
    // LC Waikiki — İstanbul only
    { merchantId: lcWaikiki.id, cityId: istanbul.id, name: 'LC Waikiki — Avm\'ler', address: 'Sambal-2, 111 AVM' },
    // Acıbadem — İstanbul + Ankara
    { merchantId: acibadem.id, cityId: istanbul.id, name: 'Acıbadem Hastanesi — İstanbul', address: 'Maslak Mahallesi 42, Sarıyer' },
    { merchantId: acibadem.id, cityId: ankara.id, name: 'Acıbadem Hastanesi — Ankara', address: 'Çankaya Caddesi 28, Ankara' },
    // Big Chef's — Ankara only
    { merchantId: bigChefs.id, cityId: ankara.id, name: 'Big Chef\'s', address: 'Tunalı Hilmi AVM, 3. Kat' },
  ];

  for (const b of branchData) {
    await prisma.branch.create({ data: b });
  }
  console.log(`✅ ${branchData.length} branches created`);

  // ══════════════════════════════════════
  // CARD TEMPLATES
  // ══════════════════════════════════════
  const templateData = [
    { merchantId: kahveDunyasi.id, name: 'Kahve ve Tatlı', denomination: 100, tokenPrice: 100, category: 'dining', bgColor: '#7C3AED', validDays: 180, isAllCities: true },
    { merchantId: kahveDunyasi.id, name: 'Öğle Yemeği İkili', denomination: 500, tokenPrice: 500, category: 'dining', bgColor: '#EC4899', validDays: 365, isAllCities: true },
    { merchantId: kahveDunyasi.id, name: 'Premium Akşam Yemeği', denomination: 1000, tokenPrice: null, category: 'dining', bgColor: '#0D9488', validDays: 365, isAllCities: true },
    { merchantId: teknosa.id, name: 'Hediye Kartı 200₺', denomination: 200, tokenPrice: 200, category: 'shopping', bgColor: '#F59E0B', validDays: 365, isAllCities: true },
    { merchantId: teknosa.id, name: 'Hediye Kartı 500₺', denomination: 500, tokenPrice: null, category: 'shopping', bgColor: '#F59E0B', validDays: 365, isAllCities: true },
    { merchantId: teknosa.id, name: 'Hediye Kartı 1000₺', denomination: 1000, tokenPrice: null, category: 'shopping', bgColor: '#F59E0B', validDays: 365, isAllCities: true },
    { merchantId: baliSpa.id, name: 'Rahatlatıcı 60 dakika', denomination: 300, tokenPrice: 300, category: 'wellness', bgColor: '#10B981', validDays: 180 },
    { merchantId: baliSpa.id, name: 'Premium Spa Günü', denomination: 700, tokenPrice: null, category: 'wellness', bgColor: '#10B981', validDays: 180 },
    { merchantId: lcWaikiki.id, name: 'Alışveriş 500₺', denomination: 500, tokenPrice: 500, category: 'shopping', bgColor: '#7C3AED', validDays: 365 },
    { merchantId: acibadem.id, name: 'Temel Kontrol', denomination: 600, tokenPrice: null, category: 'health', bgColor: '#0D9488', validDays: 365, isAllCities: true },
    { merchantId: macCenter.id, name: 'Spor 200₺', denomination: 200, tokenPrice: 200, category: 'shopping', bgColor: '#3B82F6', validDays: 365, isAllCities: true },
    { merchantId: bigChefs.id, name: 'Öğle Yemeği 100₺', denomination: 100, tokenPrice: 100, category: 'dining', bgColor: '#F97316', validDays: 90 },
  ];

  for (const t of templateData) {
    await prisma.cardTemplate.create({ data: t });
  }
  console.log(`✅ ${templateData.length} card templates created`);

  // ══════════════════════════════════════
  // USERS (hashed passwords for login)
  // ══════════════════════════════════════
  const userPassword = await bcrypt.hash('demo123', 10);
  const adminPassword = await bcrypt.hash('admin123', 10);

  const admin = await prisma.user.create({
    data: {
      name: 'Admin', phone: '+905000000001', email: 'admin@syylyq.tr',
      password: adminPassword,
      role: 'admin', tokenBalance: 10000, referralCode: 'ADMIN2026', vitaId: 'VITA-100001',
    },
  });

  const user1 = await prisma.user.create({
    data: {
      name: 'Gökhan Gökalp', phone: '+905001112233', email: 'gokhan@medime.tr',
      password: userPassword,
      role: 'user', tokenBalance: 1250, referralCode: 'GOKHAN2026', vitaId: 'VITA-100002',
    },
  });

  const user2 = await prisma.user.create({
    data: {
      name: 'Ayşe Yılmaz', phone: '+905004445566',
      password: userPassword,
      role: 'user', tokenBalance: 300, referralCode: 'AYSE2026', referredBy: 'GOKHAN2026', vitaId: 'VITA-100003',
    },
  });

  console.log(`✅ 3 users created (all with passwords: demo123 / admin123)`);

  // ══════════════════════════════════════
  // MERCHANT USERS (for merchant panel login)
  // ══════════════════════════════════════
  const hashedPassword = await bcrypt.hash('demo123', 10);

  await prisma.merchantUser.create({
    data: {
      merchantId: kahveDunyasi.id, phone: '+905010000001',
      name: 'Kahve Dünyası Manager', role: 'owner', password: hashedPassword,
    },
  });
  await prisma.merchantUser.create({
    data: {
      merchantId: teknosa.id, phone: '+905010000002',
      name: 'Teknosa Manager', role: 'owner', password: hashedPassword,
    },
  });
  await prisma.merchantUser.create({
    data: {
      merchantId: baliSpa.id, phone: '+905010000003',
      name: 'Bali Spa Manager', role: 'owner', password: hashedPassword,
    },
  });

  console.log(`✅ 3 merchant users created (password: demo123)`);

  // ══════════════════════════════════════
  // REFERRAL DATA
  // ══════════════════════════════════════
  await prisma.referral.create({
    data: {
      referrerId: user1.id,
      referredId: user2.id,
      status: 'activated',
      tokensAwarded: 100,
      firstTaskName: 'İlk Satın Alma',
      activatedAt: new Date(),
    },
  });
  console.log('✅ 1 referral created');

  // ══════════════════════════════════════
  // TOKEN TRANSACTIONS (for Gökhan)
  // ══════════════════════════════════════
  const now = new Date();
  const txData = [
    { userId: user1.id, amount: 500, type: 'topup', source: 'Banka Transferi ile Yükleme', balanceAfter: 500, createdAt: new Date(now.getTime() - 30 * 86400000) },
    { userId: user1.id, amount: 100, type: 'earn_referral', source: 'Referral — Ayşe Yılmaz', balanceAfter: 600, createdAt: new Date(now.getTime() - 25 * 86400000) },
    { userId: user1.id, amount: 95, type: 'earn_activity', source: 'Gizli Ziyaretçi — Kahve Dünyası', balanceAfter: 695, createdAt: new Date(now.getTime() - 20 * 86400000) },
    { userId: user1.id, amount: 150, type: 'earn_cashback', source: 'Cashback — Teknosa (sertifika)', balanceAfter: 845, createdAt: new Date(now.getTime() - 18 * 86400000) },
    { userId: user1.id, amount: -200, type: 'spend_purchase', source: 'Sertifika Satın Alma — Bali Spa', balanceAfter: 645, createdAt: new Date(now.getTime() - 15 * 86400000) },
    { userId: user1.id, amount: 40, type: 'earn_activity', source: 'MediMe — Doktor Ziyareti', balanceAfter: 685, createdAt: new Date(now.getTime() - 12 * 86400000) },
    { userId: user1.id, amount: 65, type: 'earn_activity', source: 'Gizli Ziyaretçi — DeFacto', balanceAfter: 750, createdAt: new Date(now.getTime() - 10 * 86400000) },
    { userId: user1.id, amount: 300, type: 'topup', source: 'Banka Transferi ile Yükleme', balanceAfter: 1050, createdAt: new Date(now.getTime() - 7 * 86400000) },
    { userId: user1.id, amount: 90, type: 'earn_cashback', source: 'Cashback — Kahve Dünyası (sertifika)', balanceAfter: 1140, createdAt: new Date(now.getTime() - 5 * 86400000) },
    { userId: user1.id, amount: 25, type: 'earn_activity', source: 'MediMe — Eczane Sipariş', balanceAfter: 1165, createdAt: new Date(now.getTime() - 3 * 86400000) },
    { userId: user1.id, amount: 50, type: 'earn_referral', source: 'Referral — Aktivite Bonusu', balanceAfter: 1215, createdAt: new Date(now.getTime() - 2 * 86400000) },
    { userId: user1.id, amount: 35, type: 'earn_activity', source: 'Gizli Ziyaretçi — LC Waikiki', balanceAfter: 1250, createdAt: new Date(now.getTime() - 1 * 86400000) },
  ];

  for (const tx of txData) {
    await prisma.tokenTransaction.create({ data: tx });
  }
  console.log(`✅ ${txData.length} token transactions created for Gökhan`);

  // ══════════════════════════════════════
  // VITA UNIVERSAL CERTIFICATES
  // Evrensel sertifika — işletmeye bağlı DEĞİL, tüm partnerlerde geçerli
  // merchantId ve templateId null — çünkü VITA sertifika belirli bir işletmeye ait değil
  // ══════════════════════════════════════
  const expiresAt = new Date();
  expiresAt.setMonth(expiresAt.getMonth() + 6);

  // 1) Arkadaştan hediye: Ayşe → Gökhan'a 300₺
  await prisma.giftCard.create({
    data: {
      buyerId: user2.id,        // Ayşe satın aldı
      recipientId: user1.id,    // Gökhan'a hediye etti
      recipientPhone: '+905001112233',
      amount: 300,
      paidAmount: 300,
      qrData: 'VITA-CERT-300-GIFT',
      code: 'SYY-VITA-GIFT1',
      status: 'active',
      isVitaCert: true,
      paidWithTokens: 0,
      message: 'Doğum günün kutlu olsun! 🎂',
      expiresAt,
    },
  });

  // 2) Kendine aldığın: Gökhan kendi 100₺ sertifika satın aldı
  await prisma.giftCard.create({
    data: {
      buyerId: user1.id,        // Gökhan kendisi satın aldı
      recipientId: user1.id,    // kendine
      amount: 100,
      paidAmount: 100,
      qrData: 'VITA-CERT-100-SELF',
      code: 'SYY-VITA-SELF1',
      status: 'active',
      isVitaCert: true,
      paidWithTokens: 0,
      expiresAt,
    },
  });

  console.log('✅ 2 VITA universal certificates created (300₺ hediye from Ayşe, 100₺ self-purchase)');

  // ══════════════════════════════════════
  // INFLUENCER CODES
  // ══════════════════════════════════════
  await Promise.all([
    prisma.influencerCode.create({
      data: { code: 'MUSTAFA2026', influencerName: 'Mustafa Kaymak', platform: 'instagram', bonusMultiplier: 2.0, specialReward: 'Premium statüsü 1 ay' },
    }),
    prisma.influencerCode.create({
      data: { code: 'TRTIKTOK', influencerName: 'TRTikTok', platform: 'tiktok', bonusMultiplier: 1.5 },
    }),
    prisma.influencerCode.create({
      data: { code: 'ISTFOOD', influencerName: 'İstanbul Yemek Rehberi', platform: 'instagram', bonusMultiplier: 1.5, specialReward: 'Kahve Dünyası Sertifikası 100₺' },
    }),
    prisma.influencerCode.create({
      data: { code: 'TECHTR', influencerName: 'TechTR', platform: 'youtube', bonusMultiplier: 1.5 },
    }),
  ]);
  console.log('✅ 4 influencer codes created');

  // ══════════════════════════════════════
  // NEARBY ME — Location data
  // ══════════════════════════════════════
  const user3 = await prisma.user.create({
    data: {
      name: 'Mehmet Demir', phone: '+905007778899',
      password: userPassword,
      role: 'user', tokenBalance: 550, referralCode: 'MEHMET2026', vitaId: 'VITA-100004',
    },
  });

  // Create user locations — around İstanbul
  // Gökhan: Kadıköy area (40.9862, 29.0295), intent: 'networking'
  await (prisma as any).userLocation.create({
    data: {
      userId: user1.id,
      latitude: 40.9862,
      longitude: 29.0295,
      intent: 'networking',
      isActive: true,
    },
  });

  // Ayşe: Beşiktaş area (41.0422, 29.0083), intent: 'sohbet'
  await (prisma as any).userLocation.create({
    data: {
      userId: user2.id,
      latitude: 41.0422,
      longitude: 29.0083,
      intent: 'sohbet',
      isActive: true,
    },
  });

  // Mehmet: Taksim area (41.0370, 28.9850), intent: 'aktivite'
  await (prisma as any).userLocation.create({
    data: {
      userId: user3.id,
      latitude: 41.0370,
      longitude: 28.9850,
      intent: 'aktivite',
      isActive: true,
    },
  });

  console.log('✅ 3 user locations created (NearbyMe test data)');

  // ══════════════════════════════════════
  // VITA JOBS — Categories
  // ══════════════════════════════════════
  const jobCategories = await Promise.all([
    prisma.jobCategory.create({ data: { name: 'Kurye & Teslimat', emoji: '🚗', color: '#3B82F6' } }),
    prisma.jobCategory.create({ data: { name: 'Temizlik', emoji: '🧹', color: '#10B981' } }),
    prisma.jobCategory.create({ data: { name: 'Tadilat & Tamir', emoji: '🔧', color: '#F59E0B' } }),
    prisma.jobCategory.create({ data: { name: 'Özel Ders', emoji: '📚', color: '#7C3AED' } }),
    prisma.jobCategory.create({ data: { name: 'Freelance IT', emoji: '💻', color: '#0D9488' } }),
    prisma.jobCategory.create({ data: { name: 'Fotoğraf & Video', emoji: '📸', color: '#EC4899' } }),
    prisma.jobCategory.create({ data: { name: 'Taşımacılık', emoji: '📦', color: '#F97316' } }),
    prisma.jobCategory.create({ data: { name: 'Evcil Hayvan', emoji: '🐕', color: '#92400E' } }),
    prisma.jobCategory.create({ data: { name: 'Çeviri & İçerik', emoji: '✍️', color: '#2563EB' } }),
    prisma.jobCategory.create({ data: { name: 'Tasarım', emoji: '🎨', color: '#EF4444' } }),
  ]);

  const [delivery, cleaning, repair, tutoring, freelanceIt, photoVideo, transport, pets, translation, design] = jobCategories;
  console.log(`✅ ${jobCategories.length} job categories created`);

  // ══════════════════════════════════════
  // VITA JOBS — Sample Jobs (Istanbul)
  // ══════════════════════════════════════
  const jobsData = [
    {
      title: 'Beyoğlu\'da acil paket teslimatı',
      description: 'Taksim\'den Harbiye\'ye 2 kg paket teslimatı, bugün öğleden sonra',
      categoryId: delivery.id,
      employerId: user1.id, // Gökhan posting
      budget: 150,
      budgetType: 'fixed',
      latitude: 41.0373,
      longitude: 28.9851,
      address: 'Taksim, İstanbul',
      cityId: istanbul.id,
      status: 'open',
      deadline: new Date(new Date().getTime() + 2 * 24 * 60 * 60 * 1000), // 2 days from now
    },
    {
      title: 'Daire temizliği - haftalık',
      description: '3 oda, 1 mutfak, 1 banyo ve 2 tuvalet. Kapıdan kapıya hizmet.',
      categoryId: cleaning.id,
      employerId: user2.id, // Ayşe posting
      budget: 250,
      budgetType: 'fixed',
      latitude: 40.9860,
      longitude: 29.0295,
      address: 'Kadıköy, İstanbul',
      cityId: istanbul.id,
      status: 'open',
      deadline: new Date(new Date().getTime() + 7 * 24 * 60 * 60 * 1000), // 1 week
    },
    {
      title: 'KPSS Matematik Özel Ders - 5 saat',
      description: '5 adet 1 saatlik KPSS matematik dersi. Çevrim içi zoom üzerinden.',
      categoryId: tutoring.id,
      employerId: user1.id,
      budget: 400,
      budgetType: 'fixed',
      latitude: 41.0082,
      longitude: 28.9784,
      address: 'İstanbul',
      cityId: istanbul.id,
      status: 'open',
      deadline: new Date(new Date().getTime() + 14 * 24 * 60 * 60 * 1000), // 2 weeks
    },
    {
      title: 'WordPress sitesi kurulumu ve SEO optimizasyon',
      description: 'Mevcut alan adı ve hosting\'e WordPress kurulup tema kurulması, basic SEO optimizasyonu',
      categoryId: freelanceIt.id,
      employerId: user3.id, // Mehmet posting
      budget: 600,
      budgetType: 'fixed',
      latitude: 41.0082,
      longitude: 28.9784,
      address: 'Online - Uzaktan',
      cityId: istanbul.id,
      status: 'open',
      deadline: new Date(new Date().getTime() + 10 * 24 * 60 * 60 * 1000),
    },
    {
      title: 'Ürün fotoğraflama - 50 adet ürün',
      description: 'E-ticaret sitesi için 50 adet ürün beyaz arka fonda fotoğraf çekimi. Editoring dahil.',
      categoryId: photoVideo.id,
      employerId: user2.id,
      budget: 1000,
      budgetType: 'fixed',
      latitude: 41.0373,
      longitude: 28.9851,
      address: 'Beyoğlu, İstanbul',
      cityId: istanbul.id,
      status: 'open',
      deadline: new Date(new Date().getTime() + 5 * 24 * 60 * 60 * 1000),
    },
  ];

  for (const jobData of jobsData) {
    await prisma.job.create({ data: jobData });
  }
  console.log(`✅ ${jobsData.length} sample jobs created (Istanbul)`);

  console.log('\n🎁 Seed completed!\n');
  console.log('── Test Credentials ──');
  console.log('Admin:     +905000000001 / admin123');
  console.log('User:      +905001112233 / demo123 (Gökhan Gökalp)');
  console.log('User:      +905004445566 / demo123 (Ayşe Yılmaz)');
  console.log('User:      +905007778899 / demo123 (Mehmet Demir)');
  console.log('Merchant:  +905010000001 / demo123 (Kahve Dünyası)');
  console.log('Merchant:  +905010000002 / demo123 (Teknosa)');
  console.log('Merchant:  +905010000003 / demo123 (Bali Spa)');
  console.log('\n── Influencer Codes ──');
  console.log('MUSTAFA2026 (x2.0), TRTIKTOK (x1.5), ISTFOOD (x1.5), TECHTR (x1.5)');
  console.log('\n── NearbyMe Locations ──');
  console.log('Gökhan:    40.9862, 29.0295 (Kadıköy) — intent: networking');
  console.log('Ayşe:      41.0422, 29.0083 (Beşiktaş) — intent: sohbet');
  console.log('Mehmet:    41.0370, 28.9850 (Taksim) — intent: aktivite\n');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());

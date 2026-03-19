// ─────────────────────────────────────────────────────
// VITA Platform — Notification Background Jobs
// Otomatik bildirim oluşturma: özel günler, hatırlatmalar,
// hediye fırsatları, sertifika→token önerisi
// ─────────────────────────────────────────────────────

// NOT: Yeni modeller (Notification, UserConnection) ve alanlar (birthday, gender)
// Prisma client regenerate edilene kadar 'any' cast kullanılır.
// Mac'te çalıştır: npx prisma generate && npx prisma db push

import { createLogger } from '../utils/logger';
const log = createLogger('NotificationJobs');

const DAY_MS = 24 * 60 * 60 * 1000;

// PrismaClient yerine any — yeni schema alanları tanınana kadar
type PrismaAny = any;

// ══════════════════════════════════════════════════════
// ANA SCHEDULER — Günde 1 kez (sabah 09:00 civarı)
// ══════════════════════════════════════════════════════

export function startNotificationJobs(prisma: PrismaAny) {
  // İlk çalıştırma: 30 saniye sonra
  setTimeout(() => runDailyNotifications(prisma), 30_000);

  // Sonra her 24 saatte bir tekrar
  setInterval(() => runDailyNotifications(prisma), DAY_MS);

  log.info('Günlük bildirim job\'ları başlatıldı');
}

async function runDailyNotifications(prisma: PrismaAny) {
  const today = new Date();
  log.info(`Günlük bildirim taraması başladı: ${today.toISOString()}`);

  try {
    await Promise.allSettled([
      checkBirthdays(prisma, today),
      checkFriendBirthdays(prisma, today),
      checkSpecialDays(prisma, today),
      checkGiftSuggestions(prisma, today),
      checkUnusedCertificates(prisma, today),
      checkNewPartners(prisma, today),
    ]);
  } catch (err) {
    log.error('Error in daily notifications', err);
  }
}

// ══════════════════════════════════════════════════════
// 1. DOĞUM GÜNÜ BİLDİRİMİ
// ══════════════════════════════════════════════════════

async function checkBirthdays(prisma: PrismaAny, today: Date) {
  const month = today.getMonth() + 1; // 1-12
  const day = today.getDate();

  // birthday alanı DateTime olduğu için ay ve gün eşleştirmesi
  // SQLite'da direkt ay/gün filtreleme yok, tüm birthday'li kullanıcıları çekip JS'de filtrele
  const usersWithBirthday = await prisma.user.findMany({
    where: { birthday: { not: null }, isActive: true },
    select: { id: true, name: true, birthday: true },
  });

  const birthdayUsers = usersWithBirthday.filter((u: any) => {
    if (!u.birthday) return false;
    const bd = new Date(u.birthday);
    return bd.getMonth() + 1 === month && bd.getDate() === day;
  });

  for (const user of birthdayUsers) {
    // Bugün zaten bildirim gönderilmiş mi kontrol et
    const existing = await prisma.notification.findFirst({
      where: {
        userId: user.id,
        type: 'special_day',
        createdAt: { gte: startOfDay(today) },
        title: { contains: 'рождения' },
      },
    });
    if (existing) continue;

    await prisma.notification.create({
      data: {
        userId: user.id,
        type: 'special_day',
        title: '🎂 С днём рождения!',
        body: `${user.name}, поздравляем с днём рождения! Подарите себе VITA Сертификат или порадуйте близких!`,
        icon: '🎂',
        actionType: 'navigate',
        actionTarget: '/gift-detail',
      },
    });
  }

  if (birthdayUsers.length > 0) {
    log.info(`${birthdayUsers.length} doğum günü bildirimi gönderildi`);
  }
}

// ══════════════════════════════════════════════════════
// 2. ARKADAŞIN DOĞUM GÜNÜ YAKLAŞIYOR
// Bağlantı kurulmuş arkadaşların doğum günü 3 gün kala hatırlatma
// ══════════════════════════════════════════════════════

async function checkFriendBirthdays(prisma: PrismaAny, today: Date) {
  // 3 gün sonrası
  const targetDate = new Date(today.getTime() + 3 * DAY_MS);
  const targetMonth = targetDate.getMonth() + 1;
  const targetDay = targetDate.getDate();

  // Kabul edilmiş tüm bağlantıları al
  const connections = await (prisma as any).userConnection.findMany({
    where: { status: 'accepted' },
    include: {
      fromUser: { select: { id: true, name: true } },
      toUser: { select: { id: true, name: true, birthday: true } },
    },
  });

  for (const conn of connections) {
    // toUser'ın doğum günü 3 gün sonra mı?
    if (!conn.toUser.birthday) continue;
    const bd = new Date(conn.toUser.birthday);
    if (bd.getMonth() + 1 !== targetMonth || bd.getDate() !== targetDay) continue;

    // Bu çift için zaten bildirim gönderilmiş mi (son 7 gün)
    const existing = await prisma.notification.findFirst({
      where: {
        userId: conn.fromUser.id,
        type: 'gift_suggestion',
        relatedId: conn.toUser.id,
        createdAt: { gte: new Date(today.getTime() - 7 * DAY_MS) },
      },
    });
    if (existing) continue;

    const friendName = conn.nickname || conn.toUser.name;
    await prisma.notification.create({
      data: {
        userId: conn.fromUser.id,
        type: 'gift_suggestion',
        title: '🎂 День рождения друга!',
        body: `Через 3 дня день рождения у ${friendName}! Подарите VITA Сертификат — порадуйте близкого человека!`,
        icon: '🎂',
        actionType: 'navigate',
        actionTarget: '/gift-detail',
        relatedId: conn.toUser.id,
      },
    });
  }

  // Ters yön: toUser → fromUser (çift yönlü kontrol)
  for (const conn of connections) {
    if (!conn.fromUser) continue;
    // fromUser'ın doğum günü kontrolü yapabilmek için ayrı sorgu gerek
    // Şimdilik tek yönlü bırakalım — ileride optimize edilir
  }
}

// ══════════════════════════════════════════════════════
// 3. ÖZEL GÜN BİLDİRİMLERİ (Kadınlar Günü, Yılbaşı vb.)
// ══════════════════════════════════════════════════════

interface SpecialDay {
  month: number;
  day: number;
  title: string;
  body: string;
  icon: string;
  daysBeforeReminder: number; // kaç gün öncesinden hatırlat
  targetGender?: 'male' | 'female' | null; // null = herkese, 'male' = sadece erkeklere
}

const SPECIAL_DAYS: SpecialDay[] = [
  // Yılbaşı — herkese
  { month: 12, day: 25, title: '🎄 Новый год близко!', body: 'Подарите VITA Сертификат близким — универсальный подарок к Новому году!', icon: '🎄', daysBeforeReminder: 7 },
  { month: 12, day: 31, title: '🎆 С Новым годом!', body: 'Ещё не поздно подарить VITA Сертификат — мгновенная доставка!', icon: '🎆', daysBeforeReminder: 0 },
  // Kadınlar Günü — ERKEKLERE bildirim (kadınları hediyeyle mutlu edin)
  { month: 3, day: 5, title: '💐 8 марта скоро!', body: 'Не забудьте поздравить любимых женщин! VITA Сертификат — идеальный подарок.', icon: '💐', daysBeforeReminder: 3, targetGender: 'male' },
  { month: 3, day: 8, title: '💐 С 8 марта!', body: 'Поздравляем с Международным женским днём! Подарите VITA Сертификат!', icon: '💐', daysBeforeReminder: 0, targetGender: 'male' },
  // 8 Mart — KADINLARA tebrik
  { month: 3, day: 8, title: '💐 С 8 марта!', body: 'Поздравляем вас с праздником! Побалуйте себя — купите VITA Сертификат!', icon: '💐', daysBeforeReminder: 0, targetGender: 'female' },
  // Sevgililer Günü — herkese
  { month: 2, day: 12, title: '❤️ День влюблённых!', body: 'Подарите любимому человеку VITA Сертификат на 14 февраля!', icon: '❤️', daysBeforeReminder: 2 },
  { month: 2, day: 14, title: '❤️ С Днём святого Валентина!', body: 'Порадуйте вторую половинку VITA Сертификатом!', icon: '❤️', daysBeforeReminder: 0 },
  // Anneler Günü — herkese (anneler evrensel)
  { month: 11, day: 22, title: '👩 День матери скоро!', body: 'Подарите маме VITA Сертификат — она заслужила!', icon: '👩', daysBeforeReminder: 3 },
  // Наурыз — herkese
  { month: 3, day: 20, title: '🌷 Наурыз мейрамы!', body: 'Поздравляем с Наурызом! Подарите близким VITA Сертификат!', icon: '🌷', daysBeforeReminder: 2 },
  // Babalar Günü — herkese (babalar evrensel)
  { month: 6, day: 14, title: '👨 День отца скоро!', body: 'Не забудьте поздравить папу! VITA Сертификат — отличный подарок.', icon: '👨', daysBeforeReminder: 2 },
  // Öğretmenler Günü — herkese
  { month: 10, day: 3, title: '📚 День учителя!', body: 'Поблагодарите учителя VITA Сертификатом!', icon: '📚', daysBeforeReminder: 2 },
  // 23 Şubat — KADINLARA bildirim (erkekleri hediyeyle mutlu edin)
  { month: 2, day: 20, title: '🎖️ 23 февраля скоро!', body: 'День защитника Отечества! Подарите мужчинам VITA Сертификат!', icon: '🎖️', daysBeforeReminder: 3, targetGender: 'female' },
  { month: 2, day: 23, title: '🎖️ С 23 февраля!', body: 'Поздравьте мужчин с праздником — VITA Сертификат порадует!', icon: '🎖️', daysBeforeReminder: 0, targetGender: 'female' },
];

async function checkSpecialDays(prisma: PrismaAny, today: Date) {
  const month = today.getMonth() + 1;
  const day = today.getDate();

  const matchingDays = SPECIAL_DAYS.filter((sd: any) => {
    // Tam gün veya hatırlatma günü mü?
    if (sd.month === month && sd.day === day) return true;
    // Hatırlatma günü kontrolü
    const specialDate = new Date(today.getFullYear(), sd.month - 1, sd.day);
    const reminderDate = new Date(specialDate.getTime() - sd.daysBeforeReminder * DAY_MS);
    return reminderDate.getMonth() + 1 === month && reminderDate.getDate() === day;
  });

  if (matchingDays.length === 0) return;

  for (const sd of matchingDays) {
    // Bugün zaten bu özel gün bildirimi gönderilmiş mi
    const existingCount = await prisma.notification.count({
      where: {
        type: 'special_day',
        title: sd.title,
        createdAt: { gte: startOfDay(today) },
      },
    });
    if (existingCount > 0) continue;

    // Gender filtreleme: targetGender varsa sadece o cinsiyete gönder
    const userWhere: any = { isActive: true };
    if (sd.targetGender) {
      userWhere.gender = sd.targetGender;
    }

    const users = await prisma.user.findMany({
      where: userWhere,
      select: { id: true },
    });

    if (users.length === 0) continue;

    await prisma.notification.createMany({
      data: users.map((u: any) => ({
        userId: u.id,
        type: 'special_day',
        title: sd.title,
        body: sd.body,
        icon: sd.icon,
        actionType: 'navigate',
        actionTarget: '/gift-detail',
      })),
    });

    const genderLabel = sd.targetGender === 'male' ? '(erkeklere)' : sd.targetGender === 'female' ? '(kadınlara)' : '(herkese)';
    log.info(`Özel gün bildirimi: "${sd.title}" ${genderLabel} → ${users.length} kullanıcıya`);
  }
}

// ══════════════════════════════════════════════════════
// 3. HEDİYE ÖNERİSİ — sürekli hediye verebilecekleri sebepleri hatırlat
// ══════════════════════════════════════════════════════

const GIFT_SUGGESTIONS = [
  { body: 'Друг получил повышение? Порадуйте VITA Сертификатом!', icon: '🎉' },
  { body: 'Кто-то переехал в новый дом? VITA Сертификат — отличный подарок на новоселье!', icon: '🏠' },
  { body: 'Выпускной, свадьба, юбилей — VITA Сертификат подходит на любой случай!', icon: '🎓' },
  { body: 'Хотите поблагодарить коллегу? Отправьте VITA Сертификат!', icon: '👏' },
  { body: 'Скучаете по друзьям? Отправьте VITA Сертификат — это как тёплое объятие!', icon: '🤗' },
  { body: 'День рождения друга на этой неделе? VITA Сертификат — быстро и удобно!', icon: '🎁' },
  { body: 'Порадуйте родителей без повода — отправьте VITA Сертификат!', icon: '💝' },
];

async function checkGiftSuggestions(prisma: PrismaAny, today: Date) {
  // Haftada 1 kez (Pazartesi) rastgele bir hediye önerisi gönder
  if (today.getDay() !== 1) return; // 1 = Pazartesi

  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  // Bu hafta zaten gönderilmiş mi
  const weekStart = new Date(today);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
  weekStart.setHours(0, 0, 0, 0);

  const existingCount = await prisma.notification.count({
    where: {
      type: 'gift_suggestion',
      createdAt: { gte: weekStart },
    },
  });
  if (existingCount > 0) return;

  // Rastgele bir öneri seç
  const suggestion = GIFT_SUGGESTIONS[Math.floor(Math.random() * GIFT_SUGGESTIONS.length)];

  await prisma.notification.createMany({
    data: users.map((u: any) => ({
      userId: u.id,
      type: 'gift_suggestion',
      title: `${suggestion.icon} Повод подарить`,
      body: suggestion.body,
      icon: suggestion.icon,
      actionType: 'navigate',
      actionTarget: '/gift-detail',
    })),
  });

  log.info(`Hediye önerisi gönderildi: ${users.length} kullanıcıya`);
}

// ══════════════════════════════════════════════════════
// 4. KULLANILMAYAN SERTİFİKA → TOKEN ÖNERİSİ
// 11 aydır kullanılmayan sertifikalar için hatırlatma
// ══════════════════════════════════════════════════════

async function checkUnusedCertificates(prisma: PrismaAny, today: Date) {
  const elevenMonthsAgo = new Date(today.getTime() - 330 * DAY_MS); // ~11 ay

  // 11 aydır kullanılmayan aktif sertifikaları bul
  const unusedCards = await prisma.giftCard.findMany({
    where: {
      status: 'active',
      purchasedAt: { lt: elevenMonthsAgo },
    },
    include: {
      buyer: { select: { id: true, name: true } },
    },
  });

  for (const card of unusedCards) {
    // Bu kart için zaten bildirim gönderilmiş mi (son 30 gün)
    const existing = await prisma.notification.findFirst({
      where: {
        userId: card.buyerId,
        type: 'cert_convert_reminder',
        relatedId: card.id,
        createdAt: { gte: new Date(today.getTime() - 30 * DAY_MS) },
      },
    });
    if (existing) continue;

    const amount = card.amount.toLocaleString('ru-RU');
    await prisma.notification.create({
      data: {
        userId: card.buyerId,
        type: 'cert_convert_reminder',
        title: '🎫 Сертификат ждёт вас!',
        body: `У вас есть VITA Сертификат на ₸${amount}. Конвертируйте в токены и тратьте частями у любого партнёра!`,
        icon: '🎫',
        actionType: 'navigate',
        actionTarget: '/(tabs)/wallet',
        relatedId: card.id,
      },
    });
  }

  if (unusedCards.length > 0) {
    log.info(`${unusedCards.length} kullanılmayan sertifika hatırlatması gönderildi`);
  }
}

// ══════════════════════════════════════════════════════
// 5. YENİ İŞLETME KATILIMI BİLDİRİMİ
// Son 24 saatte onaylanan yeni işletmeler
// ══════════════════════════════════════════════════════

async function checkNewPartners(prisma: PrismaAny, today: Date) {
  const yesterday = new Date(today.getTime() - DAY_MS);

  const newMerchants = await prisma.merchant.findMany({
    where: {
      approvalStatus: 'approved',
      updatedAt: { gte: yesterday },
    },
    select: { id: true, name: true, category: true },
  });

  if (newMerchants.length === 0) return;

  const users = await prisma.user.findMany({
    where: { isActive: true },
    select: { id: true },
  });

  for (const merchant of newMerchants) {
    // Bu merchant için zaten bildirim gönderilmiş mi
    const existingCount = await prisma.notification.count({
      where: {
        type: 'new_partner',
        relatedId: merchant.id,
      },
    });
    if (existingCount > 0) continue;

    await prisma.notification.createMany({
      data: users.map((u: any) => ({
        userId: u.id,
        type: 'new_partner',
        title: '🆕 Новый партнёр VITA!',
        body: `${merchant.name} теперь принимает VITA Сертификаты и токены!`,
        icon: '🆕',
        actionType: 'navigate',
        actionTarget: '/merchant-detail',
        relatedId: merchant.id,
      })),
    });

    log.info(`Yeni işletme bildirimi: "${merchant.name}" → ${users.length} kullanıcıya`);
  }
}

// ── Helper ──
function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

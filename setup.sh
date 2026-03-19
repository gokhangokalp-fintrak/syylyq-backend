#!/bin/bash
# ─────────────────────────────────────────────
# VITA Platform — Backend Kurulum Scripti
# ─────────────────────────────────────────────
# Kullanım: chmod +x setup.sh && ./setup.sh
# ─────────────────────────────────────────────

set -e

echo ""
echo "🎁 ═══════════════════════════════════════════"
echo "   VITA Backend — Kurulum Başlıyor"
echo "═══════════════════════════════════════════════"
echo ""

# 1. npm paketlerini kur
echo "📦 [1/5] NPM paketleri kuruluyor..."
npm install
echo "✅ NPM paketleri kuruldu"
echo ""

# 2. .env dosyası oluştur (yoksa)
if [ ! -f .env ]; then
  echo "⚙️  [2/5] .env dosyası oluşturuluyor..."
  cat > .env << 'EOF'
# VITA Backend — Environment Variables
PORT=3001
JWT_SECRET=vita-jwt-secret-change-in-production
QR_SECRET=vita-qr-hmac-secret-change-in-production
DATABASE_URL="file:./dev.db"

# Kaspi Business API (production'da gerçek key'ler girilecek)
KASPI_API_KEY=
KASPI_MERCHANT_ID=

# ForteBank Escrow API (banka ortaklığı sonrası)
FORTE_API_KEY=
FORTE_ESCROW_ACCOUNT=
EOF
  echo "✅ .env dosyası oluşturuldu"
else
  echo "⏭️  [2/5] .env dosyası zaten mevcut, atlanıyor"
fi
echo ""

# 3. Prisma client oluştur
echo "🔧 [3/5] Prisma Client oluşturuluyor..."
npx prisma generate
echo "✅ Prisma Client oluşturuldu"
echo ""

# 4. Veritabanını oluştur
echo "🗄️  [4/5] SQLite veritabanı oluşturuluyor..."
npx prisma db push
echo "✅ Veritabanı oluşturuldu"
echo ""

# 5. Seed data yükle
echo "🌱 [5/5] Demo veriler yükleniyor..."
npx tsx prisma/seed.ts
echo "✅ Demo veriler yüklendi"
echo ""

echo "═══════════════════════════════════════════════"
echo "🚀 VITA Backend hazır!"
echo ""
echo "   Çalıştırmak için: npm run dev"
echo "   API adresi:       http://localhost:3001"
echo "   Health check:     http://localhost:3001/api/health"
echo ""
echo "   Demo kullanıcılar:"
echo "   📱 +77001234567 / demo123  (Normal kullanıcı)"
echo "   📱 +77009876543 / demo123  (Admin)"
echo "   🏪 +77005551111 / demo123  (Marrone Rosso sahibi)"
echo "═══════════════════════════════════════════════"
echo ""

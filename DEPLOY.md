# VITA SuperApp — Deployment Rehberi

## Render.com ile Deploy (Önerilen)

### Ön Koşullar
- GitHub hesabı (repo push edilmiş olmalı)
- Render.com hesabı (ücretsiz plan yeterli)

### Adım 1: GitHub'a Push
```bash
cd syylyq-backend
git init
git add .
git commit -m "VITA SuperApp Backend v1.0"
git remote add origin https://github.com/MedSputnik/syylyq-backend.git
git push -u origin main
```

### Adım 2: Render Dashboard
1. https://dashboard.render.com adresine git
2. "New +" → "Blueprint" tıkla
3. GitHub repo'nu seç: `MedSputnik/syylyq-backend`
4. `render.yaml` otomatik algılanacak
5. "Apply" tıkla → PostgreSQL + Web Service oluşturulur

### Adım 3: Manuel Deploy (Blueprint kullanmadan)

**PostgreSQL (zaten mevcut):**
- Host: `dpg-d6s7i2muk2gs7384258g-a.frankfurt-postgres.render.com`
- Database: `vita_b5xi`
- User: `vita_user`

**Web Service:**
1. "New +" → "Web Service"
2. GitHub repo'nu bağla
3. Ayarlar:
   - **Name:** vita-backend
   - **Region:** Frankfurt (EU Central)
   - **Runtime:** Node
   - **Build Command:** `npm run render-build`
   - **Start Command:** `npx prisma db push --skip-generate && npm run start`
   - **Plan:** Free

4. Environment Variables ekle:
   ```
   NODE_ENV=production
   PORT=3001
   DATABASE_URL=postgresql://vita_user:PkMRUBQ6ajlhl9PHuK7GNhMypEKgXit4@dpg-d6s7i2muk2gs7384258g-a.frankfurt-postgres.render.com/vita_b5xi
   JWT_SECRET=(rastgele güçlü şifre oluştur)
   QR_SECRET=(rastgele güçlü şifre oluştur)
   ```

5. "Create Web Service" tıkla

### Adım 4: Veritabanı Şemasını Oluştur
Deploy tamamlandıktan sonra Render shell'de:
```bash
npx prisma db push
```

### Adım 5: Seed Data (İsteğe Bağlı)
```bash
npx tsx prisma/seed.ts
```

### Adım 6: Test
```
https://vita-backend.onrender.com/api/health
https://vita-backend.onrender.com/admin
https://vita-backend.onrender.com/merchant
```

---

## Yerel Test (Mac)

```bash
# 1. PostgreSQL başlat (Docker)
docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=vita123 -e POSTGRES_DB=vita --name vita-db postgres:16

# 2. .env dosyasını düzenle
DATABASE_URL="postgresql://postgres:vita123@localhost:5432/vita"

# 3. Bağımlılıkları kur
npm install

# 4. Prisma client oluştur + DB şeması push
npx prisma generate
npx prisma db push

# 5. Seed data (ilk şehirler, test merchant)
npx tsx prisma/seed.ts

# 6. Backend başlat
npm run dev

# Test URL'leri:
# http://localhost:3001/api/health
# http://localhost:3001/admin
# http://localhost:3001/merchant
```

---

## Frontend (React Native) Bağlantısı

`syylyq-test/src/services/api.ts` dosyasında API URL'ini güncelle:

**Geliştirme:**
```typescript
const API_URL = 'http://localhost:3001/api';
```

**Production:**
```typescript
const API_URL = 'https://vita-backend.onrender.com/api';
```

---

## Önemli Notlar

- Free plan'da Render 15 dk inaktivite sonrası uyku moduna geçer (ilk istek ~30sn sürer)
- Paid plan ($7/ay) ile her zaman aktif kalır
- PostgreSQL free plan 1GB limit, 90 gün sonra silinir
- Production için Starter plan ($19/ay DB + $7/ay Web) önerilir

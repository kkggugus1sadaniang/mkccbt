# Panduan Upload & Hosting SakaUjian CBT (Node.js + PostgreSQL)

## 1. Persiapan Environment Hosting
Aplikasi ini membutuhkan Node.js 20+ dan database PostgreSQL (Cloud SQL, VPS Postgres, Neon, atau layanan PostgreSQL hosting lainnya).

Siapkan variabel lingkungan berikut pada panel hosting (`.env` / Environment Variables):
- `PORT=3000`
- `NODE_ENV=production`
- `SQL_HOST=<host-atau-socket-postgresql>`
- `SQL_DB_NAME=<nama-database>`
- `SQL_USER=<user-aplikasi>`
- `SQL_PASSWORD=<password-user-aplikasi>`
- `SQL_ADMIN_USER=<user-admin-migrasi>`
- `SQL_ADMIN_PASSWORD=<password-admin-migrasi>`
- `SESSION_SECRET=<string-acak-minimal-32-karakter>`

## 2. Inisialisasi Skema SQL
Jalankan salah satu cara berikut:
1. Menggunakan Drizzle Kit:
   ```bash
   npx drizzle-kit push
   ```
2. Atau impor langsung file `database/schema.sql` ke database PostgreSQL Anda.

## 3. Build & Jalankan di Hosting
```bash
npm install
npm run build
npm start
```

## 4. Catatan Keamanan Exam Mode
Browser web standar tidak dapat menjamin penguncian perangkat 100% pada tingkat sistem operasi. Untuk ujian berisiko tinggi, gunakan perangkat terkelola (*managed device* / Chromebook Kiosk) atau peramban ujian khusus (*Safe Exam Browser*).

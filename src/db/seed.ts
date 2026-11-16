import bcrypt from 'bcryptjs';
import { count, eq } from 'drizzle-orm';
import { db } from './index.ts';
import { examQuestions, exams, questions, schoolSettings, users } from './schema.ts';

let seedPromise: Promise<void> | null = null;

async function ensureSchoolSettingsSeeded() {
  const existing = await db
    .select({ id: schoolSettings.id })
    .from(schoolSettings)
    .limit(1);
  if (!existing[0]) {
    await db.insert(schoolSettings).values({
      schoolName: 'SDN 09 SADANIANG',
      examTheme: 'Tes Akhir Semester',
      academicYear: 'Tahun Pelajaran 2026/2027',
      footerText: '© Fikrul MKC · MKC CBT',
    });
  }
}

async function ensureSuperAdminSeeded() {
  const existingAdmin = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, 'webadmin'));

  if (!existingAdmin[0]) {
    const adminPasswordHash = await bcrypt.hash('webadmin123', 10);
    await db
      .insert(users)
      .values({
        uid: 'local:super_admin:webadmin',
        username: 'webadmin',
        name: 'Super Admin MKC CBT',
        email: 'webadmin@mkccbt.local',
        role: 'super_admin',
        className: 'Administrator Sistem',
        passwordHash: adminPasswordHash,
      })
      .onConflictDoNothing();
  }
}

async function runSeed() {
  await ensureSuperAdminSeeded();
  await ensureSchoolSettingsSeeded();

  const nonAdminUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, 'guru'));
  if (nonAdminUsers.length > 0) {
    return;
  }

  const [{ value: totalUsers }] = await db.select({ value: count() }).from(users);
  if (Number(totalUsers) > 1) {
    return;
  }

  const teacherPasswordHash = await bcrypt.hash('Guru123!', 10);
  const studentPinHash = await bcrypt.hash('123456', 10);

  const [teacher] = await db
    .insert(users)
    .values({
      uid: 'local:guru:guru1',
      username: 'guru1',
      name: 'Ibu Sari Wulandari, S.Pd.',
      email: 'sari.wulandari@sekolah.sch.id',
      role: 'guru',
      className: 'Pengajar Informatika & Matematika',
      passwordHash: teacherPasswordHash,
    })
    .onConflictDoNothing()
    .returning();

  const resolvedTeacher =
    teacher ||
    (await db.select().from(users).where(eq(users.username, 'guru1')))[0];

  await db
    .insert(users)
    .values([
      {
        uid: 'local:siswa:siswa01',
        username: 'siswa01',
        name: 'Ahmad Fauzi',
        email: 'ahmad.fauzi@siswa.sch.id',
        role: 'siswa',
        className: 'XII IPA 1',
        passwordHash: studentPinHash,
        accessPin: '123456',
      },
      {
        uid: 'local:siswa:siswa02',
        username: 'siswa02',
        name: 'Nadia Putri Pratama',
        email: 'nadia.putri@siswa.sch.id',
        role: 'siswa',
        className: 'XII IPA 1',
        passwordHash: studentPinHash,
        accessPin: '123456',
      },
      {
        uid: 'local:siswa:siswa03',
        username: 'siswa03',
        name: 'Budi Santoso',
        email: 'budi.santoso@siswa.sch.id',
        role: 'siswa',
        className: 'XII IPA 2',
        passwordHash: studentPinHash,
        accessPin: '123456',
      },
    ])
    .onConflictDoNothing();

  const sampleQuestions = await db
    .insert(questions)
    .values([
      {
        teacherId: resolvedTeacher.id,
        subject: 'Informatika & Literasi Digital',
        type: 'pg',
        prompt:
          'Dalam sistem basis data relasional (SQL), perintah yang digunakan untuk mengambil data tertentu dari tabel berdasarkan kondisi tertentu adalah...',
        optionsJson: JSON.stringify([
          { key: 'A', text: 'SELECT ... FROM ... WHERE ...' },
          { key: 'B', text: 'INSERT INTO ... VALUES ...' },
          { key: 'C', text: 'ALTER TABLE ... ADD COLUMN ...' },
          { key: 'D', text: 'DROP TABLE ... IF EXISTS ...' },
        ]),
        correctAnswer: 'A',
        points: 15,
        difficulty: 'mudah',
      },
      {
        teacherId: resolvedTeacher.id,
        subject: 'Informatika & Literasi Digital',
        type: 'pg',
        prompt:
          'Mengapa aplikasi ujian berbasis komputer (CBT) menggunakan timer yang disinkronkan dengan waktu server dibandingkan hanya mengandalkan jam perangkat siswa?',
        optionsJson: JSON.stringify([
          {
            key: 'A',
            text: 'Agar tampilan jam pada layar siswa memiliki animasi lebih cepat',
          },
          {
            key: 'B',
            text: 'Untuk mencegah manipulasi waktu ujian apabila siswa mengubah jam lokal pada perangkatnya',
          },
          {
            key: 'C',
            text: 'Supaya browser tidak memerlukan koneksi internet selama ujian berlangsung',
          },
          {
            key: 'D',
            text: 'Karena HTML tidak mendukung perhitungan mundur di sisi klien',
          },
        ]),
        correctAnswer: 'B',
        points: 15,
        difficulty: 'sedang',
      },
      {
        teacherId: resolvedTeacher.id,
        subject: 'Informatika & Literasi Digital',
        type: 'benar_salah',
        prompt:
          'Pernyataan: Browser web standar dapat mengunci sistem operasi perangkat siswa 100% tanpa bantuan aplikasi kiosk atau perangkat terkelola (managed device).',
        optionsJson: null,
        correctAnswer: 'SALAH',
        points: 15,
        difficulty: 'sedang',
      },
      {
        teacherId: resolvedTeacher.id,
        subject: 'Informatika & Literasi Digital',
        type: 'benar_salah',
        prompt:
          'Pernyataan: Prepared statement atau parameterized query pada ORM SQL membantu melindungi aplikasi dari serangan SQL Injection.',
        optionsJson: null,
        correctAnswer: 'BENAR',
        points: 15,
        difficulty: 'mudah',
      },
      {
        teacherId: resolvedTeacher.id,
        subject: 'Informatika & Literasi Digital',
        type: 'isian',
        prompt:
          'Singkatan dari mekanisme keamanan web yang mencegah situs eksternal mengirimkan permintaan berbahaya atas nama sesi pengguna yang sedang login adalah ____ (4 huruf).',
        optionsJson: null,
        correctAnswer: 'CSRF,XSRF',
        points: 20,
        difficulty: 'sedang',
      },
      {
        teacherId: resolvedTeacher.id,
        subject: 'Informatika & Literasi Digital',
        type: 'uraian',
        prompt:
          'Jelaskan dua manfaat fitur autosave berkala pada aplikasi asesmen digital bagi siswa yang mengalami gangguan jaringan internet di sekolah.',
        optionsJson: null,
        correctAnswer:
          'Rubrik: (1) Jawaban tersimpan bertahap di server sehingga progres tidak hilang saat koneksi terputus; (2) Jawaban dapat dipulihkan otomatis saat koneksi kembali tanpa mengulang dari awal.',
        points: 20,
        difficulty: 'sulit',
      },
    ])
    .returning();

  const now = new Date();
  const startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const endTime = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  const [exam] = await db
    .insert(exams)
    .values({
      teacherId: resolvedTeacher.id,
      title: 'Penilaian Tengah Semester — Informatika & Keamanan Digital',
      subject: 'Informatika & Literasi Digital',
      examCode: 'UJIAN2026',
      description:
        'Asesmen digital berbasis CBT dengan pemantauan Exam Mode, autosave berkala, dan sinkronisasi waktu server.',
      durationMinutes: 45,
      startTime,
      endTime,
      questionCount: sampleQuestions.length,
      kkm: 75,
      shuffleQuestions: false,
      shuffleOptions: false,
      allowStudentViewResult: true,
      isPublished: true,
      requireFullscreen: true,
      detectTabSwitch: true,
      detectWindowBlur: true,
      blockCopyPaste: true,
      maxViolations: 3,
      violationAction: 'suspend',
      proctorPin: '998877',
    })
    .onConflictDoNothing()
    .returning();

  if (exam) {
    await db.insert(examQuestions).values(
      sampleQuestions.map((q, idx) => ({
        examId: exam.id,
        questionId: q.id,
        orderIndex: idx,
      }))
    );
  }
}

export async function ensureSeeded(): Promise<void> {
  if (!seedPromise) {
    seedPromise = runSeed().catch((err) => {
      seedPromise = null;
      console.error('Database seed failed:', err);
      throw new Error('Gagal menyiapkan data awal database.', { cause: err });
    });
  }
  return seedPromise;
}

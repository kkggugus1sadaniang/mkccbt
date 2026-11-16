import bcrypt from 'bcryptjs';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { db } from './index.ts';
import {
  examQuestions,
  examSessions,
  exams,
  questions,
  schoolSettings,
  studentAnswers,
  users,
  violationLogs,
} from './schema.ts';

export interface QuestionOption {
  key: string;
  text: string;
}

function shuffleArray<T>(items: T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function parseOptions(optionsJson: string | null): QuestionOption[] {
  if (!optionsJson) return [];
  try {
    const parsed = JSON.parse(optionsJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseTargetClasses(targetClassesJson: string | null | undefined): string[] {
  if (!targetClassesJson) return [];
  try {
    const parsed = JSON.parse(targetClassesJson);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((c) => String(c || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function isStudentClassEligible(
  studentClass: string | null | undefined,
  targetClasses: string[]
): boolean {
  if (!targetClasses || targetClasses.length === 0) return true;
  const normalizedStudent = (studentClass || '').trim().toLowerCase();
  if (!normalizedStudent) return false;
  return targetClasses.some(
    (cls) => cls.trim().toLowerCase() === normalizedStudent
  );
}

export async function getUserById(id: number) {
  try {
    const rows = await db.select().from(users).where(eq(users.id, id));
    return rows[0] || null;
  } catch (error) {
    console.error('getUserById failed:', error);
    throw new Error('Gagal memuat data pengguna.', { cause: error });
  }
}

export async function getUserByUsername(username: string) {
  try {
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.username, username.toLowerCase()));
    return rows[0] || null;
  } catch (error) {
    console.error('getUserByUsername failed:', error);
    throw new Error('Gagal mencari akun pengguna.', { cause: error });
  }
}

export async function getOrCreateFirebaseUser(
  uid: string,
  email: string,
  name: string,
  defaultRole: 'guru' | 'siswa' = 'guru'
) {
  try {
    const existing = await db.select().from(users).where(eq(users.uid, uid));
    if (existing[0]) {
      const updated = await db
        .update(users)
        .set({ email, name })
        .where(eq(users.uid, uid))
        .returning();
      return updated[0];
    }

    const baseUsername = (email.split('@')[0] || uid.slice(0, 8))
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '');
    const uniqueUsername = `${baseUsername}_${uid.slice(0, 5).toLowerCase()}`;

    const inserted = await db
      .insert(users)
      .values({
        uid,
        username: uniqueUsername,
        name,
        email,
        role: defaultRole,
        className: defaultRole === 'guru' ? 'Pengajar' : 'Umum',
        passwordHash: null,
      })
      .onConflictDoUpdate({
        target: users.uid,
        set: { email, name },
      })
      .returning();

    return inserted[0];
  } catch (error) {
    console.error('getOrCreateFirebaseUser failed:', error);
    throw new Error('Gagal menyinkronkan akun Google ke database.', { cause: error });
  }
}

export async function listStudents() {
  try {
    return await db
      .select({
        id: users.id,
        username: users.username,
        name: users.name,
        email: users.email,
        className: users.className,
        accessPin: users.accessPin,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.role, 'siswa'))
      .orderBy(desc(users.createdAt));
  } catch (error) {
    console.error('listStudents failed:', error);
    throw new Error('Gagal memuat daftar siswa.', { cause: error });
  }
}

export async function listStudentClasses(): Promise<string[]> {
  try {
    const rows = await db
      .select({ className: users.className })
      .from(users)
      .where(eq(users.role, 'siswa'));
    const unique = new Set<string>();
    for (const r of rows) {
      const clean = (r.className || '').trim();
      if (clean) unique.add(clean);
    }
    return Array.from(unique).sort((a, b) => a.localeCompare(b, 'id'));
  } catch (error) {
    console.error('listStudentClasses failed:', error);
    throw new Error('Gagal memuat daftar kelas siswa.', { cause: error });
  }
}

export async function createStudentAccount(input: {
  username: string;
  name: string;
  className: string;
  pin: string;
}) {
  try {
    const cleanUsername = input.username.toLowerCase().trim();
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.username, cleanUsername));
    if (existing[0]) {
      throw new Error('Username/NIS sudah terdaftar.');
    }
    const pinHash = await bcrypt.hash(input.pin, 10);
    const [created] = await db
      .insert(users)
      .values({
        uid: `local:siswa:${cleanUsername}:${Date.now()}`,
        username: cleanUsername,
        name: input.name.trim(),
        email: null,
        role: 'siswa',
        className: input.className.trim() || 'Umum',
        passwordHash: pinHash,
        accessPin: input.pin,
      })
      .returning({
        id: users.id,
        username: users.username,
        name: users.name,
        email: users.email,
        className: users.className,
        accessPin: users.accessPin,
        createdAt: users.createdAt,
      });
    return created;
  } catch (error: any) {
    console.error('createStudentAccount failed:', error);
    if (error?.message === 'Username/NIS sudah terdaftar.') {
      throw error;
    }
    throw new Error('Gagal menambahkan akun siswa.', { cause: error });
  }
}

export async function importStudentAccountsBatch(
  items: Array<{
    username: string;
    name: string;
    className: string;
    pin: string;
  }>
) {
  if (items.length === 0) {
    return { importedCount: 0, skippedUsernames: [] as string[], students: [] };
  }
  try {
    const existingRows = await db
      .select({ username: users.username })
      .from(users);
    const existingSet = new Set(
      existingRows.map((r) => r.username.toLowerCase().trim())
    );

    const toInsert: Array<{
      username: string;
      name: string;
      className: string;
      pin: string;
    }> = [];
    const skippedUsernames: string[] = [];

    for (const item of items) {
      const cleanU = item.username.toLowerCase().trim();
      if (existingSet.has(cleanU)) {
        skippedUsernames.push(cleanU);
        continue;
      }
      existingSet.add(cleanU);
      toInsert.push({ ...item, username: cleanU });
    }

    if (toInsert.length === 0) {
      return {
        importedCount: 0,
        skippedUsernames,
        students: [],
      };
    }

    const hashedRecords = await Promise.all(
      toInsert.map(async (item, idx) => ({
        uid: `local:siswa:${item.username}:${Date.now()}-${idx}`,
        username: item.username,
        name: item.name.trim(),
        email: null,
        role: 'siswa' as const,
        className: item.className.trim() || 'Umum',
        passwordHash: await bcrypt.hash(item.pin, 10),
        accessPin: item.pin,
      }))
    );

    const inserted = await db.transaction(async (tx) => {
      return tx
        .insert(users)
        .values(hashedRecords)
        .returning({
          id: users.id,
          username: users.username,
          name: users.name,
          email: users.email,
          className: users.className,
          accessPin: users.accessPin,
          createdAt: users.createdAt,
        });
    });

    return {
      importedCount: inserted.length,
      skippedUsernames,
      students: inserted,
    };
  } catch (error) {
    console.error('importStudentAccountsBatch failed:', error);
    throw new Error('Gagal mengimpor data akun siswa.', { cause: error });
  }
}

export async function deleteStudentAccount(studentId: number) {
  try {
    await db
      .delete(users)
      .where(and(eq(users.id, studentId), eq(users.role, 'siswa')));
  } catch (error) {
    console.error('deleteStudentAccount failed:', error);
    throw new Error('Gagal menghapus akun siswa.', { cause: error });
  }
}

export async function listTeachers() {
  try {
    const teacherRows = await db
      .select({
        id: users.id,
        username: users.username,
        name: users.name,
        email: users.email,
        className: users.className,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.role, 'guru'))
      .orderBy(desc(users.createdAt));

    if (teacherRows.length === 0) return [];
    const teacherIds = teacherRows.map((t) => t.id);

    const [qRows, examRows] = await Promise.all([
      db
        .select({ teacherId: questions.teacherId })
        .from(questions)
        .where(inArray(questions.teacherId, teacherIds)),
      db
        .select({ teacherId: exams.teacherId })
        .from(exams)
        .where(inArray(exams.teacherId, teacherIds)),
    ]);

    const qCountMap = new Map<number, number>();
    for (const q of qRows) {
      qCountMap.set(q.teacherId, (qCountMap.get(q.teacherId) || 0) + 1);
    }
    const examCountMap = new Map<number, number>();
    for (const ex of examRows) {
      examCountMap.set(ex.teacherId, (examCountMap.get(ex.teacherId) || 0) + 1);
    }

    return teacherRows.map((t) => ({
      ...t,
      questionCount: qCountMap.get(t.id) || 0,
      examCount: examCountMap.get(t.id) || 0,
    }));
  } catch (error) {
    console.error('listTeachers failed:', error);
    throw new Error('Gagal memuat daftar akun guru.', { cause: error });
  }
}

export async function createTeacherAccount(input: {
  username: string;
  name: string;
  email?: string | null;
  className: string;
  password: string;
}) {
  try {
    const cleanUsername = input.username.toLowerCase().trim();
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.username, cleanUsername));
    if (existing[0]) {
      throw new Error('Username guru sudah digunakan oleh akun lain.');
    }

    const passwordHash = await bcrypt.hash(input.password, 10);
    const [created] = await db
      .insert(users)
      .values({
        uid: `local:guru:${cleanUsername}:${Date.now()}`,
        username: cleanUsername,
        name: input.name.trim(),
        email: input.email?.trim() || null,
        role: 'guru',
        className: input.className.trim() || 'Guru Mata Pelajaran',
        passwordHash,
      })
      .returning({
        id: users.id,
        username: users.username,
        name: users.name,
        email: users.email,
        className: users.className,
        createdAt: users.createdAt,
      });

    return {
      ...created,
      questionCount: 0,
      examCount: 0,
    };
  } catch (error: any) {
    console.error('createTeacherAccount failed:', error);
    if (error?.message?.includes('sudah digunakan')) {
      throw error;
    }
    throw new Error('Gagal menambahkan akun guru baru.', { cause: error });
  }
}

export async function deleteTeacherAccount(teacherId: number) {
  try {
    const [deleted] = await db
      .delete(users)
      .where(and(eq(users.id, teacherId), eq(users.role, 'guru')))
      .returning({ id: users.id });
    if (!deleted) {
      throw new Error('Akun guru tidak ditemukan.');
    }
  } catch (error: any) {
    console.error('deleteTeacherAccount failed:', error);
    if (error?.message?.includes('tidak ditemukan')) throw error;
    throw new Error('Gagal menghapus akun guru.', { cause: error });
  }
}

export async function listTeacherQuestions(teacherId: number, isSuperAdmin = false) {
  try {
    const rows = isSuperAdmin
      ? await db.select().from(questions).orderBy(desc(questions.createdAt))
      : await db
          .select()
          .from(questions)
          .where(eq(questions.teacherId, teacherId))
          .orderBy(desc(questions.createdAt));

    if (rows.length === 0) return [];
    const creatorIds = Array.from(new Set(rows.map((r) => r.teacherId)));
    const creatorRows = await db
      .select({ id: users.id, name: users.name, username: users.username })
      .from(users)
      .where(inArray(users.id, creatorIds));
    const creatorMap = new Map(creatorRows.map((u) => [u.id, u]));

    return rows.map((q) => {
      const creator = creatorMap.get(q.teacherId);
      return {
        ...q,
        teacherName: creator?.name || 'Guru',
        teacherUsername: creator?.username || '-',
        options: parseOptions(q.optionsJson),
      };
    });
  } catch (error) {
    console.error('listTeacherQuestions failed:', error);
    throw new Error('Gagal memuat bank soal.', { cause: error });
  }
}

export async function createQuestion(
  teacherId: number,
  input: {
    subject: string;
    type: 'pg' | 'isian' | 'benar_salah' | 'uraian';
    prompt: string;
    imageData?: string | null;
    options?: QuestionOption[];
    correctAnswer: string;
    points: number;
    difficulty: string;
  }
) {
  try {
    const [created] = await db
      .insert(questions)
      .values({
        teacherId,
        subject: input.subject,
        type: input.type,
        prompt: input.prompt,
        imageData: input.imageData || null,
        optionsJson:
          input.type === 'pg' && input.options
            ? JSON.stringify(input.options)
            : null,
        correctAnswer: input.correctAnswer,
        points: input.points,
        difficulty: input.difficulty,
      })
      .returning();

    return {
      ...created,
      options: parseOptions(created.optionsJson),
    };
  } catch (error) {
    console.error('createQuestion failed:', error);
    throw new Error('Gagal menyimpan soal baru.', { cause: error });
  }
}

export async function createQuestionsBatch(
  teacherId: number,
  items: Array<{
    subject: string;
    type: 'pg' | 'isian' | 'benar_salah' | 'uraian';
    prompt: string;
    imageData?: string | null;
    options?: QuestionOption[];
    correctAnswer: string;
    points: number;
    difficulty: string;
  }>
) {
  if (items.length === 0) return [];
  try {
    const inserted = await db.transaction(async (tx) => {
      const rows = await tx
        .insert(questions)
        .values(
          items.map((input) => ({
            teacherId,
            subject: input.subject,
            type: input.type,
            prompt: input.prompt,
            imageData: input.imageData || null,
            optionsJson:
              input.type === 'pg' && input.options
                ? JSON.stringify(input.options)
                : null,
            correctAnswer: input.correctAnswer,
            points: input.points,
            difficulty: input.difficulty,
          }))
        )
        .returning();
      return rows;
    });

    return inserted.map((created) => ({
      ...created,
      options: parseOptions(created.optionsJson),
    }));
  } catch (error) {
    console.error('createQuestionsBatch failed:', error);
    throw new Error('Gagal mengimpor kumpulan soal ke database.', { cause: error });
  }
}

export async function updateQuestion(
  teacherId: number,
  questionId: number,
  input: {
    subject: string;
    type: 'pg' | 'isian' | 'benar_salah' | 'uraian';
    prompt: string;
    imageData?: string | null;
    options?: QuestionOption[];
    correctAnswer: string;
    points: number;
    difficulty: string;
  },
  isSuperAdmin = false
) {
  try {
    const [updated] = await db
      .update(questions)
      .set({
        subject: input.subject,
        type: input.type,
        prompt: input.prompt,
        imageData: input.imageData ?? null,
        optionsJson:
          input.type === 'pg' && input.options
            ? JSON.stringify(input.options)
            : null,
        correctAnswer: input.correctAnswer,
        points: input.points,
        difficulty: input.difficulty,
        updatedAt: new Date(),
      })
      .where(
        isSuperAdmin
          ? eq(questions.id, questionId)
          : and(eq(questions.id, questionId), eq(questions.teacherId, teacherId))
      )
      .returning();

    if (!updated) {
      throw new Error('Soal tidak ditemukan atau Anda tidak memiliki akses.');
    }

    return {
      ...updated,
      options: parseOptions(updated.optionsJson),
    };
  } catch (error: any) {
    console.error('updateQuestion failed:', error);
    if (error?.message?.includes('Soal tidak ditemukan')) throw error;
    throw new Error('Gagal memperbarui soal.', { cause: error });
  }
}

export async function deleteQuestion(
  teacherId: number,
  questionId: number,
  isSuperAdmin = false
) {
  try {
    await db
      .delete(questions)
      .where(
        isSuperAdmin
          ? eq(questions.id, questionId)
          : and(eq(questions.id, questionId), eq(questions.teacherId, teacherId))
      );
  } catch (error) {
    console.error('deleteQuestion failed:', error);
    throw new Error('Gagal menghapus soal.', { cause: error });
  }
}

export async function listTeacherExams(teacherId: number, isSuperAdmin = false) {
  try {
    const examRows = isSuperAdmin
      ? await db.select().from(exams).orderBy(desc(exams.createdAt))
      : await db
          .select()
          .from(exams)
          .where(eq(exams.teacherId, teacherId))
          .orderBy(desc(exams.createdAt));

    if (examRows.length === 0) return [];

    const examIds = examRows.map((e) => e.id);
    const creatorIds = Array.from(new Set(examRows.map((e) => e.teacherId)));
    const [links, sessions, creators] = await Promise.all([
      db.select().from(examQuestions).where(inArray(examQuestions.examId, examIds)),
      db.select().from(examSessions).where(inArray(examSessions.examId, examIds)),
      db
        .select({ id: users.id, name: users.name, username: users.username })
        .from(users)
        .where(inArray(users.id, creatorIds)),
    ]);
    const creatorMap = new Map(creators.map((u) => [u.id, u]));

    return examRows.map((e) => {
      const qIds = links
        .filter((l) => l.examId === e.id)
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .map((l) => l.questionId);
      const examSess = sessions.filter((s) => s.examId === e.id);
      const creator = creatorMap.get(e.teacherId);
      return {
        ...e,
        teacherName: creator?.name || 'Guru',
        teacherUsername: creator?.username || '-',
        targetClasses: parseTargetClasses(e.targetClassesJson),
        questionIds: qIds,
        sessionStats: {
          total: examSess.length,
          inProgress: examSess.filter((s) => s.status === 'in_progress').length,
          suspended: examSess.filter((s) => s.status === 'suspended').length,
          completed: examSess.filter(
            (s) => s.status === 'submitted' || s.status === 'timed_out'
          ).length,
        },
      };
    });
  } catch (error) {
    console.error('listTeacherExams failed:', error);
    throw new Error('Gagal memuat daftar ujian.', { cause: error });
  }
}

export async function createExam(
  teacherId: number,
  input: {
    title: string;
    subject: string;
    examCode: string;
    description: string;
    durationMinutes: number;
    startTime: Date;
    endTime: Date;
    questionCount: number;
    kkm: number;
    shuffleQuestions: boolean;
    shuffleOptions: boolean;
    allowStudentViewResult: boolean;
    isPublished: boolean;
    requireFullscreen: boolean;
    detectTabSwitch: boolean;
    detectWindowBlur: boolean;
    blockCopyPaste: boolean;
    maxViolations: number;
    violationAction: 'suspend' | 'auto_submit';
    proctorPin: string;
    targetClasses: string[];
    questionIds: number[];
  }
) {
  try {
    const existingCode = await db
      .select()
      .from(exams)
      .where(eq(exams.examCode, input.examCode));
    if (existingCode[0]) {
      throw new Error('Kode ujian sudah digunakan. Gunakan kode unik lain.');
    }

    const cleanTargetClasses = Array.from(
      new Set(input.targetClasses.map((c) => c.trim()).filter(Boolean))
    );

    const [created] = await db
      .insert(exams)
      .values({
        teacherId,
        title: input.title,
        subject: input.subject,
        examCode: input.examCode,
        description: input.description,
        durationMinutes: input.durationMinutes,
        startTime: input.startTime,
        endTime: input.endTime,
        questionCount: input.questionCount,
        kkm: input.kkm,
        shuffleQuestions: input.shuffleQuestions,
        shuffleOptions: input.shuffleOptions,
        allowStudentViewResult: input.allowStudentViewResult,
        isPublished: input.isPublished,
        requireFullscreen: input.requireFullscreen,
        detectTabSwitch: input.detectTabSwitch,
        detectWindowBlur: input.detectWindowBlur,
        blockCopyPaste: input.blockCopyPaste,
        maxViolations: input.maxViolations,
        violationAction: input.violationAction,
        proctorPin: input.proctorPin,
        targetClassesJson: JSON.stringify(cleanTargetClasses),
      })
      .returning();

    if (input.questionIds.length > 0) {
      await db.insert(examQuestions).values(
        input.questionIds.map((qId, idx) => ({
          examId: created.id,
          questionId: qId,
          orderIndex: idx,
        }))
      );
    }

    return {
      ...created,
      targetClasses: cleanTargetClasses,
      questionIds: input.questionIds,
    };
  } catch (error: any) {
    console.error('createExam failed:', error);
    if (error?.message?.includes('Kode ujian')) throw error;
    throw new Error('Gagal membuat ujian baru.', { cause: error });
  }
}

export async function updateExam(
  teacherId: number,
  examId: number,
  input: {
    title: string;
    subject: string;
    examCode: string;
    description: string;
    durationMinutes: number;
    startTime: Date;
    endTime: Date;
    questionCount: number;
    kkm: number;
    shuffleQuestions: boolean;
    shuffleOptions: boolean;
    allowStudentViewResult: boolean;
    isPublished: boolean;
    requireFullscreen: boolean;
    detectTabSwitch: boolean;
    detectWindowBlur: boolean;
    blockCopyPaste: boolean;
    maxViolations: number;
    violationAction: 'suspend' | 'auto_submit';
    proctorPin: string;
    targetClasses: string[];
    questionIds: number[];
  },
  isSuperAdmin = false
) {
  try {
    const existingCode = await db
      .select()
      .from(exams)
      .where(eq(exams.examCode, input.examCode));
    if (existingCode[0] && existingCode[0].id !== examId) {
      throw new Error('Kode ujian sudah digunakan oleh ujian lain.');
    }

    const cleanTargetClasses = Array.from(
      new Set(input.targetClasses.map((c) => c.trim()).filter(Boolean))
    );

    const [updated] = await db
      .update(exams)
      .set({
        title: input.title,
        subject: input.subject,
        examCode: input.examCode,
        description: input.description,
        durationMinutes: input.durationMinutes,
        startTime: input.startTime,
        endTime: input.endTime,
        questionCount: input.questionCount,
        kkm: input.kkm,
        shuffleQuestions: input.shuffleQuestions,
        shuffleOptions: input.shuffleOptions,
        allowStudentViewResult: input.allowStudentViewResult,
        isPublished: input.isPublished,
        requireFullscreen: input.requireFullscreen,
        detectTabSwitch: input.detectTabSwitch,
        detectWindowBlur: input.detectWindowBlur,
        blockCopyPaste: input.blockCopyPaste,
        maxViolations: input.maxViolations,
        violationAction: input.violationAction,
        proctorPin: input.proctorPin,
        targetClassesJson: JSON.stringify(cleanTargetClasses),
      })
      .where(
        isSuperAdmin
          ? eq(exams.id, examId)
          : and(eq(exams.id, examId), eq(exams.teacherId, teacherId))
      )
      .returning();

    if (!updated) {
      throw new Error('Ujian tidak ditemukan atau Anda tidak memiliki akses.');
    }

    await db.delete(examQuestions).where(eq(examQuestions.examId, examId));
    if (input.questionIds.length > 0) {
      await db.insert(examQuestions).values(
        input.questionIds.map((qId, idx) => ({
          examId,
          questionId: qId,
          orderIndex: idx,
        }))
      );
    }

    return {
      ...updated,
      targetClasses: cleanTargetClasses,
      questionIds: input.questionIds,
    };
  } catch (error: any) {
    console.error('updateExam failed:', error);
    if (
      error?.message?.includes('Kode ujian') ||
      error?.message?.includes('Ujian tidak ditemukan')
    ) {
      throw error;
    }
    throw new Error('Gagal memperbarui konfigurasi ujian.', { cause: error });
  }
}

export async function deleteExam(
  teacherId: number,
  examId: number,
  isSuperAdmin = false
) {
  try {
    await db
      .delete(exams)
      .where(
        isSuperAdmin
          ? eq(exams.id, examId)
          : and(eq(exams.id, examId), eq(exams.teacherId, teacherId))
      );
  } catch (error) {
    console.error('deleteExam failed:', error);
    throw new Error('Gagal menghapus ujian.', { cause: error });
  }
}

export async function lookupExamByCodeForStudent(examCode: string, studentId: number) {
  try {
    const rows = await db
      .select()
      .from(exams)
      .where(eq(exams.examCode, examCode));
    const exam = rows[0];
    if (!exam || !exam.isPublished) {
      throw new Error('Kode ujian tidak ditemukan atau belum dipublikasikan oleh guru.');
    }

    const targetClasses = parseTargetClasses(exam.targetClassesJson);
    if (targetClasses.length > 0) {
      const [student] = await db
        .select({ className: users.className })
        .from(users)
        .where(eq(users.id, studentId));
      if (!isStudentClassEligible(student?.className, targetClasses)) {
        throw new Error(
          `Ujian ini khusus untuk kelas: ${targetClasses.join(', ')}. Kelas Anda (${
            student?.className || 'Belum diatur'
          }) tidak terdaftar untuk mengikuti ujian ini.`
        );
      }
    }

    const linkedQuestions = await db
      .select()
      .from(examQuestions)
      .where(eq(examQuestions.examId, exam.id));

    const existingSessions = await db
      .select()
      .from(examSessions)
      .where(
        and(eq(examSessions.examId, exam.id), eq(examSessions.studentId, studentId))
      )
      .orderBy(desc(examSessions.startedAt));

    const existingSession = existingSessions[0] || null;
    const now = new Date();

    if (
      existingSession &&
      existingSession.status === 'in_progress' &&
      now >= existingSession.serverEndTime
    ) {
      await finalizeAndGradeSession(existingSession.id, 'timed_out');
    }

    const refreshedSession = existingSession
      ? (
          await db
            .select()
            .from(examSessions)
            .where(eq(examSessions.id, existingSession.id))
        )[0]
      : null;

    let availability: 'before_schedule' | 'after_schedule' | 'open' = 'open';
    if (now < exam.startTime) availability = 'before_schedule';
    else if (now > exam.endTime) availability = 'after_schedule';

    const effectiveCount =
      linkedQuestions.length > 0
        ? Math.min(exam.questionCount, linkedQuestions.length)
        : exam.questionCount;

    return {
      exam: {
        id: exam.id,
        title: exam.title,
        subject: exam.subject,
        examCode: exam.examCode,
        description: exam.description,
        durationMinutes: exam.durationMinutes,
        startTime: exam.startTime,
        endTime: exam.endTime,
        questionCount: effectiveCount,
        kkm: exam.kkm,
        allowStudentViewResult: exam.allowStudentViewResult,
        requireFullscreen: exam.requireFullscreen,
        detectTabSwitch: exam.detectTabSwitch,
        detectWindowBlur: exam.detectWindowBlur,
        blockCopyPaste: exam.blockCopyPaste,
        maxViolations: exam.maxViolations,
        violationAction: exam.violationAction,
        targetClasses,
      },
      availability,
      serverNow: now.toISOString(),
      existingSession: refreshedSession
        ? {
            id: refreshedSession.id,
            status: refreshedSession.status,
            startedAt: refreshedSession.startedAt,
            serverEndTime: refreshedSession.serverEndTime,
            submittedAt: refreshedSession.submittedAt,
            violationCount: refreshedSession.violationCount,
            finalScore: exam.allowStudentViewResult ? refreshedSession.finalScore : null,
            essayGraded: refreshedSession.essayGraded,
          }
        : null,
    };
  } catch (error: any) {
    console.error('lookupExamByCodeForStudent failed:', error);
    if (
      error?.message?.includes('Kode ujian tidak ditemukan') ||
      error?.message?.includes('Ujian ini khusus untuk kelas')
    ) {
      throw error;
    }
    throw new Error('Gagal memeriksa kode ujian.', { cause: error });
  }
}

export async function startOrResumeStudentSession(examId: number, studentId: number) {
  try {
    const [exam] = await db.select().from(exams).where(eq(exams.id, examId));
    if (!exam || !exam.isPublished) {
      throw new Error('Ujian tidak tersedia.');
    }

    const targetClasses = parseTargetClasses(exam.targetClassesJson);
    if (targetClasses.length > 0) {
      const [student] = await db
        .select({ className: users.className })
        .from(users)
        .where(eq(users.id, studentId));
      if (!isStudentClassEligible(student?.className, targetClasses)) {
        throw new Error(
          `Ujian ini khusus untuk kelas: ${targetClasses.join(', ')}. Kelas Anda (${
            student?.className || 'Belum diatur'
          }) tidak diizinkan mengakses ujian ini.`
        );
      }
    }

    const now = new Date();
    if (now < exam.startTime) {
      throw new Error('Ujian belum dapat dibuka sebelum jadwal dimulai.');
    }

    const existingRows = await db
      .select()
      .from(examSessions)
      .where(
        and(eq(examSessions.examId, examId), eq(examSessions.studentId, studentId))
      )
      .orderBy(desc(examSessions.startedAt));

    let session = existingRows[0];

    if (!session) {
      if (now > exam.endTime) {
        throw new Error('Jadwal ujian telah berakhir.');
      }

      const links = await db
        .select()
        .from(examQuestions)
        .where(eq(examQuestions.examId, examId));

      let candidateIds = links
        .sort((a, b) => a.orderIndex - b.orderIndex)
        .map((l) => l.questionId);

      if (candidateIds.length === 0) {
        const fallbackQs = await db
          .select()
          .from(questions)
          .where(eq(questions.teacherId, exam.teacherId));
        candidateIds = fallbackQs.map((q) => q.id);
      }

      if (candidateIds.length === 0) {
        throw new Error('Ujian belum memiliki butir soal. Hubungi guru pengampu.');
      }

      if (exam.shuffleQuestions) {
        candidateIds = shuffleArray(candidateIds);
      }
      const selectedIds = candidateIds.slice(0, Math.max(1, exam.questionCount));

      const selectedQs = await db
        .select()
        .from(questions)
        .where(inArray(questions.id, selectedIds));

      const maxPossibleScore = selectedQs.reduce((sum, q) => sum + q.points, 0);
      const durationEnd = new Date(now.getTime() + exam.durationMinutes * 60 * 1000);
      const serverEndTime =
        durationEnd < exam.endTime ? durationEnd : exam.endTime;

      const [created] = await db
        .insert(examSessions)
        .values({
          examId: exam.id,
          studentId,
          status: 'in_progress',
          questionOrderJson: JSON.stringify(selectedIds),
          startedAt: now,
          serverEndTime,
          lastSavedAt: now,
          maxPossibleScore,
        })
        .returning();

      session = created;
    } else if (
      session.status === 'in_progress' &&
      now >= session.serverEndTime
    ) {
      session = await finalizeAndGradeSession(session.id, 'timed_out');
    }

    const questionOrder: number[] = JSON.parse(session.questionOrderJson);
    const questionRows = await db
      .select()
      .from(questions)
      .where(inArray(questions.id, questionOrder));

    const questionMap = new Map(questionRows.map((q) => [q.id, q]));
    const orderedQuestions = questionOrder
      .map((id) => questionMap.get(id))
      .filter((q): q is NonNullable<typeof q> => Boolean(q))
      .map((q) => {
        let options = parseOptions(q.optionsJson);
        if (exam.shuffleOptions && options.length > 0) {
          options = shuffleArray(options);
        }
        return {
          id: q.id,
          subject: q.subject,
          type: q.type,
          prompt: q.prompt,
          imageData: q.imageData || null,
          points: q.points,
          options,
        };
      });

    const savedAnswers = await db
      .select()
      .from(studentAnswers)
      .where(eq(studentAnswers.sessionId, session.id));

    return {
      session: {
        id: session.id,
        examId: session.examId,
        status: session.status,
        startedAt: session.startedAt,
        serverEndTime: session.serverEndTime,
        submittedAt: session.submittedAt,
        lastSavedAt: session.lastSavedAt,
        violationCount: session.violationCount,
        finalScore: exam.allowStudentViewResult ? session.finalScore : null,
        essayGraded: session.essayGraded,
      },
      examConfig: {
        id: exam.id,
        title: exam.title,
        subject: exam.subject,
        examCode: exam.examCode,
        kkm: exam.kkm,
        allowStudentViewResult: exam.allowStudentViewResult,
        requireFullscreen: exam.requireFullscreen,
        detectTabSwitch: exam.detectTabSwitch,
        detectWindowBlur: exam.detectWindowBlur,
        blockCopyPaste: exam.blockCopyPaste,
        maxViolations: exam.maxViolations,
        violationAction: exam.violationAction,
      },
      questions: orderedQuestions,
      answers: savedAnswers.map((a) => ({
        questionId: a.questionId,
        answerText: a.answerText,
        isFlagged: a.isFlagged,
        updatedAt: a.updatedAt,
      })),
      serverNow: now.toISOString(),
    };
  } catch (error: any) {
    console.error('startOrResumeStudentSession failed:', error);
    if (
      error?.message?.includes('Ujian') ||
      error?.message?.includes('Jadwal')
    ) {
      throw error;
    }
    throw new Error('Gagal memulai atau memulihkan sesi ujian.', { cause: error });
  }
}

export async function autosaveStudentAnswers(
  sessionId: number,
  studentId: number,
  items: Array<{ questionId: number; answerText: string; isFlagged: boolean }>
) {
  try {
    const [session] = await db
      .select()
      .from(examSessions)
      .where(
        and(eq(examSessions.id, sessionId), eq(examSessions.studentId, studentId))
      );

    if (!session) {
      throw new Error('Sesi ujian tidak ditemukan.');
    }

    const now = new Date();
    if (session.status === 'submitted' || session.status === 'timed_out') {
      return {
        locked: true,
        status: session.status,
        savedAt: session.lastSavedAt,
        serverNow: now.toISOString(),
      };
    }

    if (now >= session.serverEndTime) {
      // Save any pending answers first before auto-locking!
      await upsertAnswersBatch(session.id, items, now);
      const finalized = await finalizeAndGradeSession(session.id, 'timed_out');
      return {
        locked: true,
        status: finalized.status,
        savedAt: now,
        serverNow: now.toISOString(),
      };
    }

    if (session.status === 'suspended') {
      return {
        locked: true,
        status: 'suspended',
        savedAt: session.lastSavedAt,
        serverNow: now.toISOString(),
      };
    }

    await upsertAnswersBatch(session.id, items, now);
    await db
      .update(examSessions)
      .set({ lastSavedAt: now })
      .where(eq(examSessions.id, session.id));

    return {
      locked: false,
      status: session.status,
      savedAt: now,
      serverNow: now.toISOString(),
    };
  } catch (error: any) {
    console.error('autosaveStudentAnswers failed:', error);
    if (error?.message?.includes('Sesi ujian')) throw error;
    throw new Error('Gagal menyimpan jawaban sementara.', { cause: error });
  }
}

async function upsertAnswersBatch(
  sessionId: number,
  items: Array<{ questionId: number; answerText: string; isFlagged: boolean }>,
  now: Date
) {
  const existing = await db
    .select()
    .from(studentAnswers)
    .where(eq(studentAnswers.sessionId, sessionId));
  const existingMap = new Map(existing.map((a) => [a.questionId, a]));

  for (const item of items) {
    const current = existingMap.get(item.questionId);
    if (current) {
      await db
        .update(studentAnswers)
        .set({
          answerText: item.answerText,
          isFlagged: item.isFlagged,
          updatedAt: now,
        })
        .where(eq(studentAnswers.id, current.id));
    } else {
      await db.insert(studentAnswers).values({
        sessionId,
        questionId: item.questionId,
        answerText: item.answerText,
        isFlagged: item.isFlagged,
        updatedAt: now,
      });
    }
  }
}

export async function recordStudentViolation(
  sessionId: number,
  studentId: number,
  input: {
    violationType: string;
    description: string;
  }
) {
  try {
    const [session] = await db
      .select()
      .from(examSessions)
      .where(
        and(eq(examSessions.id, sessionId), eq(examSessions.studentId, studentId))
      );

    if (!session) {
      throw new Error('Sesi ujian tidak ditemukan.');
    }

    const [exam] = await db
      .select()
      .from(exams)
      .where(eq(exams.id, session.examId));

    if (!exam) {
      throw new Error('Data ujian tidak ditemukan.');
    }

    if (session.status === 'submitted' || session.status === 'timed_out') {
      return {
        status: session.status,
        violationCount: session.violationCount,
        maxViolations: exam.maxViolations,
        actionTaken: 'ignored_finished',
      };
    }

    const nextCount = session.violationCount + 1;
    let nextStatus = session.status;
    let actionTaken: 'warning' | 'suspended' | 'auto_submitted' = 'warning';

    if (nextCount >= exam.maxViolations) {
      if (exam.violationAction === 'auto_submit') {
        nextStatus = 'submitted';
        actionTaken = 'auto_submitted';
      } else {
        nextStatus = 'suspended';
        actionTaken = 'suspended';
      }
    }

    await db.insert(violationLogs).values({
      sessionId: session.id,
      examId: exam.id,
      studentId,
      violationType: input.violationType,
      description: input.description,
      actionTaken,
      occurredAt: new Date(),
    });

    if (actionTaken === 'auto_submitted') {
      await db
        .update(examSessions)
        .set({ violationCount: nextCount })
        .where(eq(examSessions.id, session.id));
      await finalizeAndGradeSession(session.id, 'submitted');
    } else {
      await db
        .update(examSessions)
        .set({
          violationCount: nextCount,
          status: nextStatus,
        })
        .where(eq(examSessions.id, session.id));
    }

    return {
      status: nextStatus,
      violationCount: nextCount,
      maxViolations: exam.maxViolations,
      actionTaken,
    };
  } catch (error: any) {
    console.error('recordStudentViolation failed:', error);
    if (error?.message?.includes('tidak ditemukan')) throw error;
    throw new Error('Gagal mencatat log pelanggaran.', { cause: error });
  }
}

export async function verifyProctorPinAndUnlock(
  sessionId: number,
  studentId: number,
  pin: string
) {
  try {
    const [session] = await db
      .select()
      .from(examSessions)
      .where(
        and(eq(examSessions.id, sessionId), eq(examSessions.studentId, studentId))
      );

    if (!session) {
      throw new Error('Sesi ujian tidak ditemukan.');
    }

    const [exam] = await db
      .select()
      .from(exams)
      .where(eq(exams.id, session.examId));

    if (!exam) {
      throw new Error('Data ujian tidak ditemukan.');
    }

    if (pin.trim() !== exam.proctorPin.trim()) {
      throw new Error('PIN verifikasi guru salah. Minta guru pengawas memasukkan PIN yang benar.');
    }

    const now = new Date();
    if (now >= session.serverEndTime) {
      const finalized = await finalizeAndGradeSession(session.id, 'timed_out');
      return {
        unlocked: false,
        status: finalized.status,
        message: 'Waktu ujian telah habis saat penangguhan. Jawaban tersimpan telah dikirim otomatis.',
      };
    }

    await db
      .update(examSessions)
      .set({ status: 'in_progress' })
      .where(eq(examSessions.id, session.id));

    await db.insert(violationLogs).values({
      sessionId: session.id,
      examId: exam.id,
      studentId,
      violationType: 'proctor_unlock',
      description: 'Penangguhan ujian dibuka oleh verifikasi PIN Guru Pengawas.',
      actionTaken: 'unlocked_by_teacher',
      occurredAt: now,
    });

    return {
      unlocked: true,
      status: 'in_progress',
      message: 'Verifikasi guru berhasil. Siswa dapat melanjutkan ujian.',
    };
  } catch (error: any) {
    console.error('verifyProctorPinAndUnlock failed:', error);
    if (
      error?.message?.includes('PIN') ||
      error?.message?.includes('tidak ditemukan')
    ) {
      throw error;
    }
    throw new Error('Gagal memverifikasi PIN guru.', { cause: error });
  }
}

export async function unlockSessionByTeacher(
  teacherId: number,
  sessionId: number,
  isSuperAdmin = false
) {
  try {
    const [session] = await db
      .select()
      .from(examSessions)
      .where(eq(examSessions.id, sessionId));
    if (!session) throw new Error('Sesi tidak ditemukan.');

    const [exam] = await db
      .select()
      .from(exams)
      .where(
        isSuperAdmin
          ? eq(exams.id, session.examId)
          : and(eq(exams.id, session.examId), eq(exams.teacherId, teacherId))
      );
    if (!exam) throw new Error('Anda tidak memiliki akses ke ujian ini.');

    const now = new Date();
    if (now >= session.serverEndTime) {
      return await finalizeAndGradeSession(session.id, 'timed_out');
    }

    const [updated] = await db
      .update(examSessions)
      .set({ status: 'in_progress' })
      .where(eq(examSessions.id, session.id))
      .returning();

    await db.insert(violationLogs).values({
      sessionId: session.id,
      examId: exam.id,
      studentId: session.studentId,
      violationType: 'proctor_unlock',
      description: 'Penangguhan dibuka langsung melalui Dashboard Guru.',
      actionTaken: 'unlocked_by_teacher',
      occurredAt: now,
    });

    return updated;
  } catch (error: any) {
    console.error('unlockSessionByTeacher failed:', error);
    if (error?.message?.includes('tidak')) throw error;
    throw new Error('Gagal membuka penangguhan sesi.', { cause: error });
  }
}

export async function finalizeAndGradeSession(
  sessionId: number,
  finalStatus: 'submitted' | 'timed_out'
) {
  try {
    const [session] = await db
      .select()
      .from(examSessions)
      .where(eq(examSessions.id, sessionId));
    if (!session) throw new Error('Sesi ujian tidak ditemukan.');

    const questionOrder: number[] = JSON.parse(session.questionOrderJson);
    const questionRows = await db
      .select()
      .from(questions)
      .where(inArray(questions.id, questionOrder));
    const questionMap = new Map(questionRows.map((q) => [q.id, q]));

    const answers = await db
      .select()
      .from(studentAnswers)
      .where(eq(studentAnswers.sessionId, session.id));
    const answerMap = new Map(answers.map((a) => [a.questionId, a]));

    let autoScore = 0;
    let essayScore = 0;
    let maxPossibleScore = 0;
    let hasEssay = false;

    for (const qId of questionOrder) {
      const q = questionMap.get(qId);
      if (!q) continue;
      maxPossibleScore += q.points;

      const ans = answerMap.get(qId);
      const rawAns = ans?.answerText?.trim() || '';

      if (q.type === 'uraian') {
        hasEssay = true;
        essayScore += ans?.manualPoints || 0;
        continue;
      }

      let isCorrect = false;
      if (q.type === 'pg' || q.type === 'benar_salah') {
        isCorrect = rawAns.toUpperCase() === q.correctAnswer.trim().toUpperCase();
      } else if (q.type === 'isian') {
        const accepted = q.correctAnswer
          .split(',')
          .map((s) => s.trim().toLowerCase())
          .filter(Boolean);
        isCorrect = rawAns.length > 0 && accepted.includes(rawAns.toLowerCase());
      }

      const pts = isCorrect ? q.points : 0;
      autoScore += pts;

      if (ans) {
        await db
          .update(studentAnswers)
          .set({ autoPoints: pts, isCorrect })
          .where(eq(studentAnswers.id, ans.id));
      } else {
        await db.insert(studentAnswers).values({
          sessionId: session.id,
          questionId: qId,
          answerText: '',
          isFlagged: false,
          autoPoints: 0,
          manualPoints: 0,
          isCorrect: false,
        });
      }
    }

    const finalScore =
      maxPossibleScore > 0
        ? Math.round(((autoScore + essayScore) / maxPossibleScore) * 100)
        : 0;

    const now = new Date();
    const [updated] = await db
      .update(examSessions)
      .set({
        status: finalStatus,
        submittedAt: session.submittedAt || now,
        lastSavedAt: now,
        autoScore,
        essayScore,
        maxPossibleScore,
        finalScore,
        essayGraded: hasEssay ? session.essayGraded : true,
      })
      .where(eq(examSessions.id, session.id))
      .returning();

    return updated;
  } catch (error) {
    console.error('finalizeAndGradeSession failed:', error);
    throw new Error('Gagal memproses pengiriman dan penilaian ujian.', {
      cause: error,
    });
  }
}

export async function submitStudentExam(
  sessionId: number,
  studentId: number,
  finalAnswers?: Array<{ questionId: number; answerText: string; isFlagged: boolean }>
) {
  try {
    const [session] = await db
      .select()
      .from(examSessions)
      .where(
        and(eq(examSessions.id, sessionId), eq(examSessions.studentId, studentId))
      );
    if (!session) throw new Error('Sesi ujian tidak ditemukan.');

    if (finalAnswers && finalAnswers.length > 0 && session.status === 'in_progress') {
      await upsertAnswersBatch(session.id, finalAnswers, new Date());
    }

    if (session.status === 'submitted' || session.status === 'timed_out') {
      return await getStudentSessionResult(session.id, studentId);
    }

    const now = new Date();
    const targetStatus = now >= session.serverEndTime ? 'timed_out' : 'submitted';
    await finalizeAndGradeSession(session.id, targetStatus);
    return await getStudentSessionResult(session.id, studentId);
  } catch (error: any) {
    console.error('submitStudentExam failed:', error);
    if (error?.message?.includes('Sesi ujian')) throw error;
    throw new Error('Gagal mengirim jawaban ujian.', { cause: error });
  }
}

export async function getStudentSessionResult(sessionId: number, studentId: number) {
  try {
    const [session] = await db
      .select()
      .from(examSessions)
      .where(
        and(eq(examSessions.id, sessionId), eq(examSessions.studentId, studentId))
      );
    if (!session) throw new Error('Sesi ujian tidak ditemukan.');

    const [exam] = await db
      .select()
      .from(exams)
      .where(eq(exams.id, session.examId));
    if (!exam) throw new Error('Data ujian tidak ditemukan.');

    const answers = await db
      .select()
      .from(studentAnswers)
      .where(eq(studentAnswers.sessionId, session.id));

    const questionOrder: number[] = JSON.parse(session.questionOrderJson);
    const answeredCount = answers.filter((a) => a.answerText.trim().length > 0).length;

    return {
      session: {
        id: session.id,
        status: session.status,
        startedAt: session.startedAt,
        submittedAt: session.submittedAt,
        violationCount: session.violationCount,
        totalQuestions: questionOrder.length,
        answeredCount,
        allowStudentViewResult: exam.allowStudentViewResult,
        finalScore: exam.allowStudentViewResult ? session.finalScore : null,
        autoScore: exam.allowStudentViewResult ? session.autoScore : null,
        essayScore: exam.allowStudentViewResult ? session.essayScore : null,
        maxPossibleScore: exam.allowStudentViewResult ? session.maxPossibleScore : null,
        kkm: exam.kkm,
        passedKkm: exam.allowStudentViewResult
          ? session.finalScore >= exam.kkm
          : null,
        essayGraded: session.essayGraded,
        teacherNotes: exam.allowStudentViewResult ? session.teacherNotes : '',
      },
      exam: {
        id: exam.id,
        title: exam.title,
        subject: exam.subject,
        examCode: exam.examCode,
      },
    };
  } catch (error: any) {
    console.error('getStudentSessionResult failed:', error);
    if (error?.message?.includes('tidak ditemukan')) throw error;
    throw new Error('Gagal memuat ringkasan hasil ujian.', { cause: error });
  }
}

export async function getStudentHistory(studentId: number) {
  try {
    const sessions = await db
      .select()
      .from(examSessions)
      .where(eq(examSessions.studentId, studentId))
      .orderBy(desc(examSessions.startedAt));

    if (sessions.length === 0) return [];
    const examIds = Array.from(new Set(sessions.map((s) => s.examId)));
    const examRows = await db
      .select()
      .from(exams)
      .where(inArray(exams.id, examIds));
    const examMap = new Map(examRows.map((e) => [e.id, e]));

    return sessions.map((s) => {
      const e = examMap.get(s.examId);
      return {
        id: s.id,
        examId: s.examId,
        examTitle: e?.title || 'Ujian',
        subject: e?.subject || '-',
        examCode: e?.examCode || '-',
        status: s.status,
        startedAt: s.startedAt,
        submittedAt: s.submittedAt,
        violationCount: s.violationCount,
        allowStudentViewResult: e?.allowStudentViewResult || false,
        finalScore: e?.allowStudentViewResult ? s.finalScore : null,
        kkm: e?.kkm || 75,
      };
    });
  } catch (error) {
    console.error('getStudentHistory failed:', error);
    throw new Error('Gagal memuat riwayat ujian siswa.', { cause: error });
  }
}

export async function getTeacherDashboardData(
  teacherId: number,
  isSuperAdmin = false
) {
  try {
    const teacherExams = isSuperAdmin
      ? await db.select().from(exams).orderBy(desc(exams.createdAt))
      : await db
          .select()
          .from(exams)
          .where(eq(exams.teacherId, teacherId))
          .orderBy(desc(exams.createdAt));

    const teacherQuestions = isSuperAdmin
      ? await db.select().from(questions)
      : await db
          .select()
          .from(questions)
          .where(eq(questions.teacherId, teacherId));

    const studentRows = await db
      .select()
      .from(users)
      .where(eq(users.role, 'siswa'));

    const examIds = teacherExams.map((e) => e.id);
    const sessions =
      examIds.length > 0
        ? await db
            .select()
            .from(examSessions)
            .where(inArray(examSessions.examId, examIds))
            .orderBy(desc(examSessions.startedAt))
        : [];

    const violations =
      examIds.length > 0
        ? await db
            .select()
            .from(violationLogs)
            .where(inArray(violationLogs.examId, examIds))
            .orderBy(desc(violationLogs.occurredAt))
        : [];

    const completedSessions = sessions.filter(
      (s) => s.status === 'submitted' || s.status === 'timed_out'
    );
    const avgScore =
      completedSessions.length > 0
        ? Math.round(
            completedSessions.reduce((acc, s) => acc + s.finalScore, 0) /
              completedSessions.length
          )
        : 0;

    const examMap = new Map(teacherExams.map((e) => [e.id, e]));
    const passedCount = completedSessions.filter((s) => {
      const ex = examMap.get(s.examId);
      return ex ? s.finalScore >= ex.kkm : false;
    }).length;

    const studentMap = new Map(studentRows.map((u) => [u.id, u]));

    return {
      stats: {
        totalExams: teacherExams.length,
        totalQuestions: teacherQuestions.length,
        totalStudents: studentRows.length,
        totalSessions: sessions.length,
        activeOrSuspended: sessions.filter(
          (s) => s.status === 'in_progress' || s.status === 'suspended'
        ).length,
        completedCount: completedSessions.length,
        averageScore: avgScore,
        passRate:
          completedSessions.length > 0
            ? Math.round((passedCount / completedSessions.length) * 100)
            : 0,
        totalViolations: violations.filter(
          (v) => v.violationType !== 'proctor_unlock'
        ).length,
      },
      recentExams: teacherExams.slice(0, 5),
      recentViolations: violations.slice(0, 8).map((v) => ({
        ...v,
        studentName: studentMap.get(v.studentId)?.name || 'Siswa',
        studentUsername: studentMap.get(v.studentId)?.username || '-',
        examTitle: examMap.get(v.examId)?.title || 'Ujian',
        examCode: examMap.get(v.examId)?.examCode || '-',
      })),
    };
  } catch (error) {
    console.error('getTeacherDashboardData failed:', error);
    throw new Error('Gagal memuat ringkasan dashboard guru.', { cause: error });
  }
}

export async function getTeacherResults(
  teacherId: number,
  examIdFilter?: number,
  isSuperAdmin = false
) {
  try {
    const teacherExams = isSuperAdmin
      ? await db.select().from(exams).orderBy(desc(exams.createdAt))
      : await db
          .select()
          .from(exams)
          .where(eq(exams.teacherId, teacherId))
          .orderBy(desc(exams.createdAt));

    const examIds = teacherExams
      .filter((e) => !examIdFilter || e.id === examIdFilter)
      .map((e) => e.id);

    if (examIds.length === 0) {
      return { exams: teacherExams, sessions: [] };
    }

    const sessions = await db
      .select()
      .from(examSessions)
      .where(inArray(examSessions.examId, examIds))
      .orderBy(desc(examSessions.startedAt));

    const studentIds = Array.from(new Set(sessions.map((s) => s.studentId)));
    const studentRows =
      studentIds.length > 0
        ? await db.select().from(users).where(inArray(users.id, studentIds))
        : [];
    const studentMap = new Map(studentRows.map((s) => [s.id, s]));
    const examMap = new Map(teacherExams.map((e) => [e.id, e]));

    const enriched = sessions.map((s) => {
      const student = studentMap.get(s.studentId);
      const exam = examMap.get(s.examId);
      const endRef = s.submittedAt || new Date();
      const durationSeconds = Math.max(
        0,
        Math.floor((endRef.getTime() - s.startedAt.getTime()) / 1000)
      );

      return {
        ...s,
        durationSeconds,
        studentName: student?.name || 'Siswa',
        studentUsername: student?.username || '-',
        studentClass: student?.className || '-',
        examTitle: exam?.title || 'Ujian',
        examCode: exam?.examCode || '-',
        kkm: exam?.kkm || 75,
        passedKkm: s.finalScore >= (exam?.kkm || 75),
      };
    });

    return {
      exams: teacherExams,
      sessions: enriched,
    };
  } catch (error) {
    console.error('getTeacherResults failed:', error);
    throw new Error('Gagal memuat hasil ujian siswa.', { cause: error });
  }
}

export async function getTeacherSessionDetail(
  teacherId: number,
  sessionId: number,
  isSuperAdmin = false
) {
  try {
    const [session] = await db
      .select()
      .from(examSessions)
      .where(eq(examSessions.id, sessionId));
    if (!session) throw new Error('Sesi tidak ditemukan.');

    const [exam] = await db
      .select()
      .from(exams)
      .where(
        isSuperAdmin
          ? eq(exams.id, session.examId)
          : and(eq(exams.id, session.examId), eq(exams.teacherId, teacherId))
      );
    if (!exam) throw new Error('Anda tidak memiliki akses ke sesi ini.');

    const [student] = await db
      .select()
      .from(users)
      .where(eq(users.id, session.studentId));

    const qOrder: number[] = JSON.parse(session.questionOrderJson);
    const qRows = await db
      .select()
      .from(questions)
      .where(inArray(questions.id, qOrder));
    const qMap = new Map(qRows.map((q) => [q.id, q]));

    const ansRows = await db
      .select()
      .from(studentAnswers)
      .where(eq(studentAnswers.sessionId, session.id));
    const ansMap = new Map(ansRows.map((a) => [a.questionId, a]));

    const logs = await db
      .select()
      .from(violationLogs)
      .where(eq(violationLogs.sessionId, session.id))
      .orderBy(desc(violationLogs.occurredAt));

    const items = qOrder
      .map((qId) => qMap.get(qId))
      .filter((q): q is NonNullable<typeof q> => Boolean(q))
      .map((q) => {
        const a = ansMap.get(q.id);
        return {
          questionId: q.id,
          type: q.type,
          prompt: q.prompt,
          imageData: q.imageData || null,
          options: parseOptions(q.optionsJson),
          correctAnswer: q.correctAnswer,
          maxPoints: q.points,
          studentAnswer: a?.answerText || '',
          isFlagged: a?.isFlagged || false,
          autoPoints: a?.autoPoints || 0,
          manualPoints: a?.manualPoints || 0,
          isCorrect: a?.isCorrect ?? null,
        };
      });

    return {
      session,
      exam,
      student: student
        ? {
            id: student.id,
            name: student.name,
            username: student.username,
            className: student.className,
          }
        : null,
      items,
      violations: logs,
    };
  } catch (error: any) {
    console.error('getTeacherSessionDetail failed:', error);
    if (error?.message?.includes('tidak')) throw error;
    throw new Error('Gagal memuat detail lembar jawaban siswa.', { cause: error });
  }
}

export async function gradeSessionEssays(
  teacherId: number,
  sessionId: number,
  grades: Array<{ questionId: number; manualPoints: number }>,
  teacherNotes: string,
  isSuperAdmin = false
) {
  try {
    const [session] = await db
      .select()
      .from(examSessions)
      .where(eq(examSessions.id, sessionId));
    if (!session) throw new Error('Sesi tidak ditemukan.');

    const [exam] = await db
      .select()
      .from(exams)
      .where(
        isSuperAdmin
          ? eq(exams.id, session.examId)
          : and(eq(exams.id, session.examId), eq(exams.teacherId, teacherId))
      );
    if (!exam) throw new Error('Anda tidak memiliki akses.');

    const qOrder: number[] = JSON.parse(session.questionOrderJson);
    const qRows = await db
      .select()
      .from(questions)
      .where(inArray(questions.id, qOrder));
    const qMap = new Map(qRows.map((q) => [q.id, q]));

    for (const item of grades) {
      const q = qMap.get(item.questionId);
      if (!q) continue;
      const boundedPoints = Math.max(0, Math.min(q.points, Math.round(item.manualPoints)));
      const existing = await db
        .select()
        .from(studentAnswers)
        .where(
          and(
            eq(studentAnswers.sessionId, session.id),
            eq(studentAnswers.questionId, item.questionId)
          )
        );
      if (existing[0]) {
        await db
          .update(studentAnswers)
          .set({
            manualPoints: boundedPoints,
            isCorrect: boundedPoints > 0,
          })
          .where(eq(studentAnswers.id, existing[0].id));
      } else {
        await db.insert(studentAnswers).values({
          sessionId: session.id,
          questionId: item.questionId,
          answerText: '',
          manualPoints: boundedPoints,
          isCorrect: boundedPoints > 0,
        });
      }
    }

    const allAnswers = await db
      .select()
      .from(studentAnswers)
      .where(eq(studentAnswers.sessionId, session.id));

    const autoScore = allAnswers.reduce((s, a) => s + a.autoPoints, 0);
    const essayScore = allAnswers.reduce((s, a) => s + a.manualPoints, 0);
    const finalScore =
      session.maxPossibleScore > 0
        ? Math.round(((autoScore + essayScore) / session.maxPossibleScore) * 100)
        : 0;

    const [updated] = await db
      .update(examSessions)
      .set({
        autoScore,
        essayScore,
        finalScore,
        essayGraded: true,
        teacherNotes,
      })
      .where(eq(examSessions.id, session.id))
      .returning();

    return updated;
  } catch (error: any) {
    console.error('gradeSessionEssays failed:', error);
    if (error?.message?.includes('tidak')) throw error;
    throw new Error('Gagal menyimpan penilaian uraian.', { cause: error });
  }
}

export async function deleteStudentSession(
  teacherId: number,
  sessionId: number,
  isSuperAdmin = false
) {
  try {
    const [session] = await db
      .select()
      .from(examSessions)
      .where(eq(examSessions.id, sessionId));
    if (!session) throw new Error('Sesi tidak ditemukan.');

    const [exam] = await db
      .select()
      .from(exams)
      .where(
        isSuperAdmin
          ? eq(exams.id, session.examId)
          : and(eq(exams.id, session.examId), eq(exams.teacherId, teacherId))
      );
    if (!exam) throw new Error('Anda tidak memiliki akses.');

    await db.delete(examSessions).where(eq(examSessions.id, sessionId));
  } catch (error: any) {
    console.error('deleteStudentSession failed:', error);
    if (error?.message?.includes('tidak')) throw error;
    throw new Error('Gagal mereset sesi ujian siswa.', { cause: error });
  }
}

export async function getTeacherViolationLogs(
  teacherId: number,
  examIdFilter?: number,
  isSuperAdmin = false
) {
  try {
    const teacherExams = isSuperAdmin
      ? await db.select().from(exams).orderBy(desc(exams.createdAt))
      : await db
          .select()
          .from(exams)
          .where(eq(exams.teacherId, teacherId))
          .orderBy(desc(exams.createdAt));

    const examIds = teacherExams
      .filter((e) => !examIdFilter || e.id === examIdFilter)
      .map((e) => e.id);

    if (examIds.length === 0) {
      return { exams: teacherExams, logs: [] };
    }

    const logs = await db
      .select()
      .from(violationLogs)
      .where(inArray(violationLogs.examId, examIds))
      .orderBy(desc(violationLogs.occurredAt));

    const studentIds = Array.from(new Set(logs.map((l) => l.studentId)));
    const studentRows =
      studentIds.length > 0
        ? await db.select().from(users).where(inArray(users.id, studentIds))
        : [];
    const studentMap = new Map(studentRows.map((s) => [s.id, s]));
    const examMap = new Map(teacherExams.map((e) => [e.id, e]));

    return {
      exams: teacherExams,
      logs: logs.map((l) => ({
        ...l,
        studentName: studentMap.get(l.studentId)?.name || 'Siswa',
        studentUsername: studentMap.get(l.studentId)?.username || '-',
        studentClass: studentMap.get(l.studentId)?.className || '-',
        examTitle: examMap.get(l.examId)?.title || 'Ujian',
        examCode: examMap.get(l.examId)?.examCode || '-',
      })),
    };
  } catch (error) {
    console.error('getTeacherViolationLogs failed:', error);
    throw new Error('Gagal memuat audit log pelanggaran.', { cause: error });
  }
}

export async function getSchoolSettings() {
  try {
    const rows = await db
      .select()
      .from(schoolSettings)
      .orderBy(schoolSettings.id)
      .limit(1);
    if (rows[0]) {
      return rows[0];
    }
    const [created] = await db
      .insert(schoolSettings)
      .values({
        schoolName: 'SDN 09 SADANIANG',
        examTheme: 'Tes Akhir Semester',
        academicYear: 'Tahun Pelajaran 2026/2027',
        footerText: '© Fikrul MKC · MKC CBT',
      })
      .returning();
    return created;
  } catch (error) {
    console.error('getSchoolSettings failed:', error);
    throw new Error('Gagal memuat pengaturan sekolah.', { cause: error });
  }
}

export async function updateSchoolSettings(input: {
  schoolName: string;
  examTheme: string;
  academicYear: string;
  footerText: string;
}) {
  try {
    const existing = await getSchoolSettings();
    const [updated] = await db
      .update(schoolSettings)
      .set({
        schoolName: input.schoolName.trim(),
        examTheme: input.examTheme.trim(),
        academicYear: input.academicYear.trim(),
        footerText: input.footerText.trim() || '© MKC CBT',
        updatedAt: new Date(),
      })
      .where(eq(schoolSettings.id, existing.id))
      .returning();
    return updated;
  } catch (error) {
    console.error('updateSchoolSettings failed:', error);
    throw new Error('Gagal menyimpan pengaturan sekolah.', { cause: error });
  }
}

export async function getPublicPortalInfo() {
  try {
    const [settings, studentRows, [{ value: examCount }], [{ value: completedCount }]] =
      await Promise.all([
        getSchoolSettings(),
        db
          .select({ className: users.className })
          .from(users)
          .where(eq(users.role, 'siswa')),
        db
          .select({ value: count() })
          .from(exams)
          .where(eq(exams.isPublished, true)),
        db
          .select({ value: count() })
          .from(examSessions)
          .where(inArray(examSessions.status, ['submitted', 'timed_out'])),
      ]);

    const classSet = new Set<string>();
    for (const s of studentRows) {
      const cls = (s.className || '').trim();
      if (cls) classSet.add(cls.toLowerCase());
    }

    return {
      schoolName: settings.schoolName,
      examTheme: settings.examTheme,
      academicYear: settings.academicYear,
      footerText: settings.footerText,
      updatedAt: settings.updatedAt,
      serverTime: new Date().toISOString(),
      stats: {
        studentCount: studentRows.length,
        classCount: classSet.size,
        examCount: Number(examCount) || 0,
        completedSessionCount: Number(completedCount) || 0,
      },
    };
  } catch (error) {
    console.error('getPublicPortalInfo failed:', error);
    throw new Error('Gagal memuat status portal CBT.', { cause: error });
  }
}

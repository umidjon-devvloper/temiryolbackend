import { z } from 'zod';

/** Decimal string ("12,5" yoki "12.5") yoki number */
const decimalInput = z.union([z.string(), z.number()]).optional();

/** ISO sana — frontenddan test rejimida kelishi mumkin */
const dateISOSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();

// ─── Lokomotiv ────────────────────────────────────────────────────
export const lokomotivCreateSchema = z.object({
  stationId: z.string().min(1),
  nodeId: z.string().min(1),

  harakatTuri: z.enum(['yuk', 'yolovchi', 'manyovr', 'xojalik', 'ijara']),
  rusumi: z.string().min(1),
  lokomotivNumber: z.string().min(1),

  poyezdNumber: z.string().optional().default(''),
  ruxsatIndeksi: z.string().optional().default(''),
  poyezdVazni: decimalInput,

  qoldiq: decimalInput,
  qanchaBerildi: decimalInput,
  dizMasla: decimalInput,

  stansiya: z.string().optional().default(''),
  tashkilot: z.string().optional().default(''),
  ijarachi: z.string().optional().default(''),
  // Frontend zagranitsa'ni raqam yoki matn qilib yuborishi mumkin
  zagranitsa: z.union([z.string(), z.number()]).optional(),
  jadval: z.string().optional().default(''),

  mashinadaYetkazildi: z.boolean().optional().default(false),
  mashinaRaqami: z.string().optional().default(''),

  reportDateISO: dateISOSchema, // test rejim uchun
});

// ─── Korxona ──────────────────────────────────────────────────────
export const korxonaCreateSchema = z.object({
  stationId: z.string().min(1),
  nodeId: z.string().min(1),

  korxonaNomi: z.string().min(1).default('Predpriyatie'),
  poyezdNumber: z.string().optional().default(''),
  ruxsatIndeksi: z.string().optional().default(''),

  qancha: decimalInput,
  nechaSutkalik: z.union([z.string(), z.number()]).default(1),

  buyruqNumber: z.string().optional().default(''),
  kimTomonidan: z.string().optional().default(''),
  buyruqVaqti: z.number().optional(),

  mashinadaYetkazildi: z.boolean().optional().default(false),
  mashinaRaqami: z.string().optional().default(''),

  reportDateISO: dateISOSchema,
});

// ─── Qurilish ─────────────────────────────────────────────────────
// Hamma maydon ixtiyoriy, faqat zapravka bog'lanishi majburiy
export const qurulishCreateSchema = z.object({
  stationId: z.string().min(1),
  nodeId: z.string().min(1),

  korxonaNomi: z.string().optional().default(''),
  texnikaSoni: z.union([z.string(), z.number()]).optional(),
  obyekt: z.string().optional().default(''),
  masulShaxs: z.string().optional().default(''),
  lavozim: z.string().optional().default(''),

  qanchaOlindi: decimalInput,
  qanchaBerildi: decimalInput,
  dopLimit: decimalInput,

  seriya: z.string().optional().default(''),
  raqami: z.string().optional().default(''),
  poyezdNumber: z.string().optional().default(''),
  ruxsatIndeksi: z.string().optional().default(''),
  poyezdVazni: decimalInput,
  qoldiq: decimalInput,

  buyruqNumber: z.string().optional().default(''),
  kimTomonidan: z.string().optional().default(''),
  buyruqVaqti: z.number().optional(),

  mashinadaYetkazildi: z.boolean().optional().default(false),
  mashinaRaqami: z.string().optional().default(''),

  reportDateISO: dateISOSchema,
});

// ─── Tamirlash ────────────────────────────────────────────────────
export const tamirlashCreateSchema = z.object({
  stationId: z.string().min(1),
  nodeId: z.string().min(1),

  seriya: z.string().min(1),
  raqami: z.string().min(1),
  tamirlashTuri: z.enum(['katta', 'kichik', 'profilaktika']),
  qanchaBerildi: decimalInput,
  dizMasla: decimalInput,
  masulShaxs: z.string().min(1),

  mashinadaYetkazildi: z.boolean().optional().default(false),
  mashinaRaqami: z.string().optional().default(''),

  reportDateISO: dateISOSchema,
});

// ─── Universal patch (admin va worker uchun bitta schema) ─────────
export const submissionPatchSchema = z.record(z.unknown());

// ─── Query (list) ─────────────────────────────────────────────────
export const submissionListQuerySchema = z.object({
  stationId: z.string().optional(),
  category: z.enum(['lokomotiv', 'korxona', 'qurulish', 'tamirlash', 'all']).default('all'),
  dateISO: dateISOSchema,
  startDate: dateISOSchema,
  endDate: dateISOSchema,
  limit: z.coerce.number().int().min(1).max(10000).default(100),
  skip: z.coerce.number().int().min(0).default(0),
});

export type LokomotivCreateInput = z.infer<typeof lokomotivCreateSchema>;
export type KorxonaCreateInput = z.infer<typeof korxonaCreateSchema>;
export type QurulishCreateInput = z.infer<typeof qurulishCreateSchema>;
export type TamirlashCreateInput = z.infer<typeof tamirlashCreateSchema>;
export type SubmissionListQuery = z.infer<typeof submissionListQuerySchema>;

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { StaffModel, StationModel, UserModel, AuditLogModel } from '@/models';
import { authMiddleware, requireRole } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/middleware/async-handler';
import { ApiError } from '@/common/errors/api-error';
import { getIO } from '@/config/socket';

const router = Router();
router.use(authMiddleware);

// ─── Xodim ↔ worker login kodi bog'lash ───────────────────────────
// Xodim (staff) yaratilganda unga 4 raqamli kirish kodi (users) ham
// ochiladi: tabelNumber = login kod. O'chirilganda kod deaktiv qilinadi.

/** Frontend zapravka nomi "Toshkent zapravka" → station "Toshkent" (id "toshkent"). */
async function resolveStation(zapravka: string, stationId?: string | null) {
  if (stationId) {
    const byId = await StationModel.findById(stationId).lean();
    if (byId) return byId;
  }
  let st = await StationModel.findOne({ name: zapravka }).lean();
  if (!st) {
    const cleaned = zapravka.replace(/\s*zapravka\s*$/i, '').trim();
    if (cleaned) {
      st =
        (await StationModel.findOne({ name: cleaned }).lean()) ||
        (await StationModel.findOne({ slug: cleaned.toLowerCase() }).lean());
    }
  }
  return st;
}

/**
 * Xodim tabelNumber'i bo'yicha worker login kodini upsert qiladi.
 * Agar kod allaqachon admin/developer kodi bo'lsa — 'conflict' qaytaradi
 * (boshqa birovning kirish kodini bosib olmaslik uchun).
 */
async function syncWorkerCode(opts: {
  code: string;
  fullName: string;
  stationId: string | null;
  nodeId: string | null;
  isActive: boolean;
}): Promise<'ok' | 'conflict'> {
  const existing = await UserModel.findOne({ code: opts.code }).lean();
  if (existing && existing.role !== 'worker') return 'conflict';

  await UserModel.updateOne(
    { code: opts.code },
    {
      $set: {
        role: 'worker',
        displayName: opts.fullName,
        stationId: opts.stationId,
        nodeId: opts.nodeId,
        isActive: opts.isActive,
      },
      $setOnInsert: { code: opts.code, codeType: 'reserve' },
    },
    { upsert: true },
  );
  return 'ok';
}

/** Worker login kodini deaktiv qiladi (xodim o'chirilganda). */
async function deactivateWorkerCode(code: string): Promise<void> {
  await UserModel.updateOne({ code, role: 'worker' }, { $set: { isActive: false } });
}

function notifyStaffAndUsers(): void {
  try {
    getIO().to('admin').emit('staff.updated', {});
    getIO().to('admin').emit('users.updated', {});
  } catch {
    /* socket hali tayyor bo'lmasa — jim o'tamiz */
  }
}

// ─── Schemas ───
const createSchema = z.object({
  tabelNumber: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}$/, 'tabelNumber 4 ta belgidan (harf yoki raqam) iborat bo\'lishi kerak'),
  fullName: z.string().min(2).max(120).trim(),
  erju: z.string().min(1),
  zapravka: z.string().min(1),
  stationId: z.string().optional(),
  nodeId: z.string().optional(),
});

const updateSchema = createSchema.partial().extend({
  isActive: z.boolean().optional(),
});

const querySchema = z.object({
  q: z.string().optional(),                 // search by name or tabel
  stationId: z.string().optional(),
  nodeId: z.string().optional(),
  isActive: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(2000).default(100),
  skip: z.coerce.number().int().min(0).default(0),
});

// ─── Read (worker ham o'qiy oladi — o'z stationi uchun) ───────────
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const q = querySchema.parse(req.query);
    const filter: Record<string, unknown> = {};

    // Worker scope
    if (req.user!.role === 'worker') {
      filter.stationId = req.user!.stationId;
    } else {
      if (q.stationId) filter.stationId = q.stationId;
      if (q.nodeId) filter.nodeId = q.nodeId;
    }

    if (q.isActive !== undefined) filter.isActive = q.isActive;

    if (q.q) {
      const regex = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      Object.assign(filter, {
        $or: [{ fullName: regex }, { tabelNumber: regex }],
      });
    }

    const [items, total] = await Promise.all([
      StaffModel.find(filter).sort({ fullName: 1 }).skip(q.skip).limit(q.limit).lean(),
      StaffModel.countDocuments(filter),
    ]);

    res.json({ ok: true, items, total, skip: q.skip, limit: q.limit });
  }),
);

router.get(
  '/by-tabel/:tabel',
  asyncHandler(async (req: Request, res: Response) => {
    const tabel = String(req.params.tabel ?? '');
    const staff = await StaffModel.findOne({ tabelNumber: tabel }).lean();
    if (!staff) throw ApiError.notFound('Xodim topilmadi');

    // Worker faqat o'z stationidagi xodimni ko'ra oladi
    if (req.user!.role === 'worker' && staff.stationId !== req.user!.stationId) {
      throw ApiError.forbidden('Bu xodim sizning zapravkangizniki emas');
    }

    res.json({ ok: true, staff });
  }),
);

// ─── Write — admin/developer ──────────────────────────────────────
router.post(
  '/',
  requireRole('admin', 'developer'),
  asyncHandler(async (req: Request, res: Response) => {
    const input = createSchema.parse(req.body);

    // stationId resolve qilish — yo'q bo'lsa zapravka nomi orqali
    const station = await resolveStation(input.zapravka, input.stationId ?? null);
    const stationId = input.stationId ?? station?._id ?? null;
    const nodeId = input.nodeId ?? station?.nodeId ?? null;

    const exists = await StaffModel.findOne({ tabelNumber: input.tabelNumber }).lean();
    if (exists) throw ApiError.conflict('Bu tabel raqami allaqachon mavjud');

    // Login kodi sifatida tabelNumber boshqa rol (admin/developer) tomonidan band emasligini tekshirish
    const codeOwner = await UserModel.findOne({ code: input.tabelNumber }).lean();
    if (codeOwner && codeOwner.role !== 'worker') {
      throw ApiError.conflict(
        `${input.tabelNumber} kodi allaqachon ${codeOwner.role} kodi sifatida band. Boshqa tabel raqami tanlang.`,
      );
    }

    const doc = await StaffModel.create({
      ...input,
      stationId,
      nodeId,
      isActive: true,
    });

    // Xodimga 4 raqamli worker login kodi ochish (tabelNumber = kod)
    await syncWorkerCode({
      code: input.tabelNumber,
      fullName: input.fullName,
      stationId,
      nodeId,
      isActive: true,
    });

    await AuditLogModel.create({
      userId: req.user!.code,
      userName: req.user!.displayName,
      userRole: req.user!.role,
      action: 'create',
      entityType: 'staff',
      entityId: String(doc._id),
      changes: { fullName: { old: null, new: input.fullName } },
    });

    notifyStaffAndUsers();
    res.status(201).json({ ok: true, staff: doc.toObject() });
  }),
);

router.patch(
  '/:id',
  requireRole('admin', 'developer'),
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    const updates = updateSchema.parse(req.body);

    const existing = await StaffModel.findById(id).lean();
    if (!existing) throw ApiError.notFound('Xodim topilmadi');

    const tabelChanged = !!updates.tabelNumber && updates.tabelNumber !== existing.tabelNumber;

    // tabelNumber o'zgartirilsa unikallikni tekshirish (staff + login kodi)
    if (tabelChanged) {
      const dup = await StaffModel.findOne({ tabelNumber: updates.tabelNumber }).lean();
      if (dup) throw ApiError.conflict('Bu tabel raqami band');
      const codeOwner = await UserModel.findOne({ code: updates.tabelNumber }).lean();
      if (codeOwner && codeOwner.role !== 'worker') {
        throw ApiError.conflict(
          `${updates.tabelNumber} kodi allaqachon ${codeOwner.role} kodi sifatida band.`,
        );
      }
    }

    const updated = await StaffModel.findByIdAndUpdate(id, { $set: updates }, { new: true }).lean();

    // Worker login kodini xodim bilan sinxronlash
    if (updated) {
      const station = await resolveStation(updated.zapravka, updated.stationId ?? null);
      if (tabelChanged) {
        // Eski kodni deaktiv qilib, yangi tabel bo'yicha kod ochamiz
        await deactivateWorkerCode(existing.tabelNumber);
      }
      await syncWorkerCode({
        code: updated.tabelNumber,
        fullName: updated.fullName,
        stationId: updated.stationId ?? station?._id ?? null,
        nodeId: updated.nodeId ?? station?.nodeId ?? null,
        isActive: updated.isActive !== false,
      });
    }

    await AuditLogModel.create({
      userId: req.user!.code,
      userName: req.user!.displayName,
      userRole: req.user!.role,
      action: 'update',
      entityType: 'staff',
      entityId: id,
      changes: updates,
    });

    notifyStaffAndUsers();
    res.json({ ok: true, staff: updated });
  }),
);

router.delete(
  '/:id',
  requireRole('admin', 'developer'),
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    const existing = await StaffModel.findById(id).lean();
    if (!existing) throw ApiError.notFound('Xodim topilmadi');

    // Soft delete — isActive false
    await StaffModel.findByIdAndUpdate(id, { $set: { isActive: false } });

    // Xodimning login kodini ham deaktiv qilamiz (kirish to'xtaydi)
    await deactivateWorkerCode(existing.tabelNumber);

    await AuditLogModel.create({
      userId: req.user!.code,
      userName: req.user!.displayName,
      userRole: req.user!.role,
      action: 'delete',
      entityType: 'staff',
      entityId: id,
      changes: { isActive: { old: true, new: false } },
    });

    notifyStaffAndUsers();
    res.json({ ok: true });
  }),
);

export { router as staffRouter };

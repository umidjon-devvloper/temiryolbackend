import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { UserModel, AuditLogModel, SessionModel } from '@/models';
import { authMiddleware, requireRole } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/middleware/async-handler';
import { ApiError } from '@/common/errors/api-error';

const router = Router();
router.use(authMiddleware);
router.use(requireRole('admin', 'developer'));

const createSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}$/, 'Kod 4 ta belgidan (harf yoki raqam) iborat bo\'lishi kerak'),
  role: z.enum(['worker', 'admin', 'developer']),
  displayName: z.string().min(1).max(120).trim(),
  nodeId: z.string().nullable().optional(),
  stationId: z.string().nullable().optional(),
  codeType: z.enum(['main', 'reserve', 'admin', 'developer']).default('main'),
  isActive: z.boolean().default(true),
});

const updateSchema = createSchema.partial();

const querySchema = z.object({
  q: z.string().optional(),
  role: z.enum(['worker', 'admin', 'developer']).optional(),
  stationId: z.string().optional(),
  nodeId: z.string().optional(),
  isActive: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  skip: z.coerce.number().int().min(0).default(0),
});

// ─── List ─────────────────────────────────────────────────────────
router.get(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const q = querySchema.parse(req.query);
    const filter: Record<string, unknown> = {};
    if (q.role) filter.role = q.role;
    if (q.stationId) filter.stationId = q.stationId;
    if (q.nodeId) filter.nodeId = q.nodeId;
    if (q.isActive !== undefined) filter.isActive = q.isActive;
    if (q.q) {
      const regex = new RegExp(q.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      Object.assign(filter, { $or: [{ code: regex }, { displayName: regex }] });
    }

    const [items, total] = await Promise.all([
      UserModel.find(filter).sort({ code: 1 }).skip(q.skip).limit(q.limit).lean(),
      UserModel.countDocuments(filter),
    ]);

    res.json({ ok: true, items, total, skip: q.skip, limit: q.limit });
  }),
);

// ─── Create ───────────────────────────────────────────────────────
router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const input = createSchema.parse(req.body);

    const exists = await UserModel.findOne({ code: input.code }).lean();
    if (exists) throw ApiError.conflict('Bu kod allaqachon mavjud');

    const doc = await UserModel.create({
      ...input,
      nodeId: input.nodeId ?? null,
      stationId: input.stationId ?? null,
    });

    await AuditLogModel.create({
      userId: req.user!.code,
      userName: req.user!.displayName,
      userRole: req.user!.role,
      action: 'create',
      entityType: 'user',
      entityId: String(doc._id),
      changes: { code: { old: null, new: input.code }, role: { old: null, new: input.role } },
    });

    res.status(201).json({ ok: true, user: doc.toObject() });
  }),
);

// ─── Update ───────────────────────────────────────────────────────
router.patch(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    const updates = updateSchema.parse(req.body);

    const existing = await UserModel.findById(id).lean();
    if (!existing) throw ApiError.notFound('Foydalanuvchi topilmadi');

    if (updates.code && updates.code !== existing.code) {
      const dup = await UserModel.findOne({ code: updates.code }).lean();
      if (dup) throw ApiError.conflict('Bu kod band');
    }

    const updated = await UserModel.findByIdAndUpdate(id, { $set: updates }, { new: true }).lean();

    // Agar isActive=false bo'lsa → faol sessiyalarni yopish
    if (updates.isActive === false) {
      await SessionModel.deleteMany({ code: existing.code });
    }

    await AuditLogModel.create({
      userId: req.user!.code,
      userName: req.user!.displayName,
      userRole: req.user!.role,
      action: 'update',
      entityType: 'user',
      entityId: id,
      changes: updates,
    });

    res.json({ ok: true, user: updated });
  }),
);

// ─── Delete (soft) ────────────────────────────────────────────────
router.delete(
  '/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const id = String(req.params.id ?? '');
    const existing = await UserModel.findById(id).lean();
    if (!existing) throw ApiError.notFound('Foydalanuvchi topilmadi');

    await UserModel.findByIdAndUpdate(id, { $set: { isActive: false } });
    // Sessiyalarni yopish
    await SessionModel.deleteMany({ code: existing.code });

    await AuditLogModel.create({
      userId: req.user!.code,
      userName: req.user!.displayName,
      userRole: req.user!.role,
      action: 'delete',
      entityType: 'user',
      entityId: id,
      changes: { isActive: { old: true, new: false } },
    });

    res.json({ ok: true });
  }),
);

export { router as usersRouter };

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { BlockedCodeModel, AuditLogModel, SessionModel } from '@/models';
import { authMiddleware, requireRole } from '@/middleware/auth.middleware';
import { asyncHandler } from '@/middleware/async-handler';
import { ApiError } from '@/common/errors/api-error';
import { ServerEvents } from '@/events';
import { getIO } from '@/config/socket';

const router = Router();
router.use(authMiddleware);
router.use(requireRole('admin', 'developer'));

const blockSchema = z.object({
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}$/, 'Kod 4 ta belgidan (harf yoki raqam) iborat bo\'lishi kerak'),
  note: z.string().max(500).default(''),
});

router.get(
  '/',
  asyncHandler(async (_req: Request, res: Response) => {
    const items = await BlockedCodeModel.find().sort({ blockedAt: -1 }).lean();
    res.json({ ok: true, items, total: items.length });
  }),
);

router.post(
  '/',
  asyncHandler(async (req: Request, res: Response) => {
    const input = blockSchema.parse(req.body);
    const exists = await BlockedCodeModel.findOne({ code: input.code }).lean();
    if (exists) throw ApiError.conflict('Bu kod allaqachon bloklangan');

    const doc = await BlockedCodeModel.create({
      code: input.code,
      note: input.note,
      blockedAt: Date.now(),
      blockedBy: req.user!.code,
      blockedByDisplayName: req.user!.displayName,
    });

    // Faol sessiyalarni yopish
    await SessionModel.deleteMany({ code: input.code });

    await AuditLogModel.create({
      userId: req.user!.code,
      userName: req.user!.displayName,
      userRole: req.user!.role,
      action: 'block',
      entityType: 'code',
      entityId: input.code,
      changes: { note: { old: null, new: input.note } },
    });

    // Realtime — admin paneliga xabar
    getIO().to('admin').emit(ServerEvents.BLOCKED_CODES_UPDATED, { action: 'added', code: input.code });

    res.status(201).json({ ok: true, blocked: doc.toObject() });
  }),
);

router.delete(
  '/:code',
  asyncHandler(async (req: Request, res: Response) => {
    const code = String(req.params.code ?? '');
    const existing = await BlockedCodeModel.findOne({ code }).lean();
    if (!existing) throw ApiError.notFound('Bu kod bloklanmagan');

    await BlockedCodeModel.deleteOne({ code });

    await AuditLogModel.create({
      userId: req.user!.code,
      userName: req.user!.displayName,
      userRole: req.user!.role,
      action: 'unblock',
      entityType: 'code',
      entityId: code,
      changes: {},
    });

    getIO().to('admin').emit(ServerEvents.BLOCKED_CODES_UPDATED, { action: 'removed', code });

    res.json({ ok: true });
  }),
);

export { router as blockedCodesRouter };

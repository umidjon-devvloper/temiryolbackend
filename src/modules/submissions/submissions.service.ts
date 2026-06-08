import mongoose from 'mongoose';
import {
  SubmissionModel,
  LokomotivSubmissionModel,
  KorxonaSubmissionModel,
  QurulishSubmissionModel,
  TamirlashSubmissionModel,
  AuditLogModel,
} from '@/models';
import { ApiError } from '@/common/errors/api-error';
import { toDecimal, roundKg } from '@/common/utils/decimal';
import { toDateISO, yearOf, isSameDay } from '@/common/utils/dates';
import { env } from '@/config/env';
import { logger } from '@/common/utils/logger';
import { writeFuelRecord, deleteFuelRecordBySubmission } from '@/modules/fuel-records/fuel-records.service';
import { summariesService } from '@/modules/summaries/summaries.service';
import { broadcastSubmissionChange } from '@/config/socket';
import type {
  LokomotivCreateInput,
  KorxonaCreateInput,
  QurulishCreateInput,
  TamirlashCreateInput,
  SubmissionListQuery,
} from './submissions.validators';
import type { Category, JwtPayload, HarakatTuri } from '@/common/types';

// ─── Yordamchi: meta maydonlar (timestamp, dateISO, ...) ─────────
function buildMeta(reportDateISO?: string) {
  const now = Date.now();
  const dateISO = env.ALLOW_DATE_OVERRIDE && reportDateISO ? reportDateISO : toDateISO(now);
  const dateParts = dateISO.split('-').map(Number);
  return {
    timestamp: now,
    timestampMs: now,
    dateISO,
    year: dateParts[0]!,
    month: dateParts[1]!,
    day: dateParts[2]!,
  };
}

/**
 * MongoDB transaction launcher.
 * Standalone (replica set bo'lmagan) MongoDB lar uchun fallback — transaction yo'q.
 */
async function runWithTransaction<T>(fn: (session: mongoose.ClientSession | undefined) => Promise<T>): Promise<T> {
  // Replica set bormi tekshirish
  try {
    const session = await mongoose.startSession();
    try {
      let result: T;
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      return result!;
    } finally {
      await session.endSession();
    }
  } catch (err) {
    // Standalone MongoDB transaction qo'llab-quvvatlamasligi mumkin
    const msg = (err as Error).message || '';
    if (msg.includes('Transaction numbers') || msg.includes('replica set') || msg.includes('IllegalOperation')) {
      logger.warn('Transaction qo\'llab-quvvatlanmaydi — fallback ishlatilmoqda (Atlas yoki replica set tavsiya)');
      return await fn(undefined);
    }
    throw err;
  }
}

class SubmissionsService {
  // ─── Lokomotiv ─────────────────────────────────────────────────
  async createLokomotiv(input: LokomotivCreateInput, user: JwtPayload) {
    if (!input.stationId || !input.nodeId) throw ApiError.badRequest('stationId va nodeId majburiy');

    const meta = buildMeta(input.reportDateISO);
    const qanchaBerildi = roundKg(toDecimal(input.qanchaBerildi));
    const dizMasla = roundKg(toDecimal(input.dizMasla));
    const qoldiq = roundKg(toDecimal(input.qoldiq));
    const poyezdVazni = roundKg(toDecimal(input.poyezdVazni));

    if (qanchaBerildi <= 0) {
      throw ApiError.badRequest('qanchaBerildi 0 dan katta bo\'lishi kerak');
    }

    if (input.mashinadaYetkazildi && !input.mashinaRaqami) {
      throw ApiError.badRequest('mashinadaYetkazildi=true bo\'lsa mashinaRaqami majburiy');
    }

    // Harakat turi bo'yicha qo'shimcha validatsiya
    this.validateLokomotivHarakat(input);

    const id = await runWithTransaction(async (session) => {
      const [doc] = await LokomotivSubmissionModel.create(
        [
          {
            category: 'lokomotiv' as const,
            staffCode: user.code,
            staffName: user.displayName,
            stationId: input.stationId,
            nodeId: input.nodeId,
            ...meta,

            harakatTuri: input.harakatTuri,
            rusumi: input.rusumi,
            lokomotivNumber: input.lokomotivNumber,
            poyezdNumber: input.poyezdNumber ?? '',
            ruxsatIndeksi: input.ruxsatIndeksi ?? '',
            poyezdVazni,
            qoldiq,
            qanchaBerildi,
            dizMasla,
            stansiya: input.stansiya ?? '',
            tashkilot: input.tashkilot ?? '',
            ijarachi: input.ijarachi ?? '',
            zagranitsa: input.zagranitsa ?? '',
            jadval: input.jadval ?? '',
            mashinadaYetkazildi: input.mashinadaYetkazildi ?? false,
            mashinaRaqami: input.mashinaRaqami ?? '',
          },
        ],
        { session },
      );

      const submissionId = String(doc._id);

      // Fuel record — moveType = harakatTuri
      // locoNumber: manyovr=stansiya, xojalik=tashkilot, ijara=ijarachi, aks=poyezdNumber
      let locoNumber = input.poyezdNumber ?? '';
      if (input.harakatTuri === 'manyovr') locoNumber = input.stansiya ?? '';
      else if (input.harakatTuri === 'xojalik') locoNumber = input.tashkilot ?? '';
      else if (input.harakatTuri === 'ijara') locoNumber = input.ijarachi ?? '';

      await writeFuelRecord(
        {
          submissionId,
          category: 'lokomotiv',
          stationId: input.stationId,
          nodeId: input.nodeId,
          dateISO: meta.dateISO,
          timestamp: meta.timestamp,
          staffCode: user.code,
          staffName: user.displayName,
          moveType: input.harakatTuri,
          locoSeries: input.rusumi,
          locoCode: input.lokomotivNumber,
          locoNumber,
          trainIndex: input.ruxsatIndeksi ?? '',
          weight: poyezdVazni > 0 ? poyezdVazni : '',
          balanceBeforeKg: qoldiq,
          fuelAmountKg: qanchaBerildi,
          maslaAmountKg: dizMasla,
        },
        session,
      );

      // Summaries
      await summariesService.onCreate(
        {
          dateISO: meta.dateISO,
          year: meta.year,
          stationId: input.stationId,
          nodeId: input.nodeId,
          category: 'lokomotiv',
          harakatTuri: input.harakatTuri,
          fuelKgDelta: qanchaBerildi,
          maslaKgDelta: dizMasla,
          countDelta: 1,
        },
        session,
      );

      // Umumiy kategoriya summary (harakatTuri=null bilan ham yozamiz)
      await summariesService.onCreate(
        {
          dateISO: meta.dateISO,
          year: meta.year,
          stationId: input.stationId,
          nodeId: input.nodeId,
          category: 'lokomotiv',
          harakatTuri: null,
          fuelKgDelta: qanchaBerildi,
          maslaKgDelta: dizMasla,
          countDelta: 1,
        },
        session,
      );

      return submissionId;
    });

    // Realtime broadcast
    broadcastSubmissionChange('created', {
      id,
      category: 'lokomotiv',
      stationId: input.stationId,
      nodeId: input.nodeId,
      harakatTuri: input.harakatTuri,
      qanchaBerildi,
      dateISO: meta.dateISO,
    });

    // Audit
    await AuditLogModel.create({
      userId: user.code,
      userName: user.displayName,
      userRole: user.role,
      action: 'create',
      entityType: 'submission',
      entityId: id,
      changes: { category: { old: null, new: 'lokomotiv' }, qanchaBerildi: { old: null, new: qanchaBerildi } },
    });

    return { id, ...meta };
  }

  private validateLokomotivHarakat(input: LokomotivCreateInput) {
    const t = input.harakatTuri;
    if (t === 'manyovr' && !input.stansiya) {
      throw ApiError.badRequest('Manyovr uchun stansiya majburiy');
    }
    if (t === 'xojalik' && !input.tashkilot) {
      throw ApiError.badRequest('Xo\'jalik uchun tashkilot majburiy');
    }
    if (t === 'ijara' && !input.ijarachi) {
      throw ApiError.badRequest('Ijara uchun ijarachi majburiy');
    }
    if (t === 'yuk' && (!input.poyezdVazni || toDecimal(input.poyezdVazni) <= 0)) {
      // poyezdVazni yuk uchun majburiy — lekin 0 ham ruxsat etiladi (ko'rsatma kelganda)
    }
  }

  // ─── Korxona ───────────────────────────────────────────────────
  async createKorxona(input: KorxonaCreateInput, user: JwtPayload) {
    const meta = buildMeta(input.reportDateISO);
    const qancha = roundKg(toDecimal(input.qancha));
    const nechaSutkalik = Math.max(1, Number(input.nechaSutkalik) || 1);

    if (qancha <= 0) throw ApiError.badRequest('qancha 0 dan katta bo\'lishi kerak');
    if (!input.korxonaNomi) throw ApiError.badRequest('korxonaNomi majburiy');

    if (input.mashinadaYetkazildi && !input.mashinaRaqami) {
      throw ApiError.badRequest('mashinadaYetkazildi=true bo\'lsa mashinaRaqami majburiy');
    }

    const id = await runWithTransaction(async (session) => {
      const [doc] = await KorxonaSubmissionModel.create(
        [
          {
            category: 'korxona' as const,
            staffCode: user.code,
            staffName: user.displayName,
            stationId: input.stationId,
            nodeId: input.nodeId,
            ...meta,

            korxonaNomi: input.korxonaNomi,
            poyezdNumber: input.poyezdNumber ?? '',
            ruxsatIndeksi: input.ruxsatIndeksi ?? '',
            qancha,
            nechaSutkalik,
            buyruqNumber: input.buyruqNumber ?? '',
            kimTomonidan: input.kimTomonidan ?? '',
            buyruqVaqti: input.buyruqVaqti ?? null,
            mashinadaYetkazildi: input.mashinadaYetkazildi ?? false,
            mashinaRaqami: input.mashinaRaqami ?? '',
            limit: 0,
            limitKg: 0,
            excessKg: 0,
            oshiqMiqdor: 0,
            isOverLimit: false,
            approvalId: null,
          },
        ],
        { session },
      );

      const submissionId = String(doc._id);

      await writeFuelRecord(
        {
          submissionId,
          category: 'korxona',
          stationId: input.stationId,
          nodeId: input.nodeId,
          dateISO: meta.dateISO,
          timestamp: meta.timestamp,
          staffCode: user.code,
          staffName: user.displayName,
          moveType: 'korxona',
          locoNumber: input.poyezdNumber ?? '',
          trainIndex: input.ruxsatIndeksi ?? '',
          fuelAmountKg: qancha,
        },
        session,
      );

      await summariesService.onCreate(
        {
          dateISO: meta.dateISO,
          year: meta.year,
          stationId: input.stationId,
          nodeId: input.nodeId,
          category: 'korxona',
          harakatTuri: null,
          fuelKgDelta: qancha,
          maslaKgDelta: 0,
          countDelta: 1,
        },
        session,
      );

      return submissionId;
    });

    broadcastSubmissionChange('created', {
      id,
      category: 'korxona',
      stationId: input.stationId,
      nodeId: input.nodeId,
      qancha,
      isOverLimit: false,
      dateISO: meta.dateISO,
    });

    await AuditLogModel.create({
      userId: user.code,
      userName: user.displayName,
      userRole: user.role,
      action: 'create',
      entityType: 'submission',
      entityId: id,
      changes: { qancha: { old: null, new: qancha } },
    });

    return { id, isOverLimit: false, ...meta };
  }

  // ─── Qurilish ──────────────────────────────────────────────────
  async createQurulish(input: QurulishCreateInput, user: JwtPayload) {
    const meta = buildMeta(input.reportDateISO);

    // Hamma raqam ixtiyoriy → bo'sh bo'lsa 0
    const qanchaOlindi = roundKg(toDecimal(input.qanchaOlindi));
    const qanchaBerildi = roundKg(toDecimal(input.qanchaBerildi));
    const fuelAmount = qanchaOlindi > 0 ? qanchaOlindi : qanchaBerildi;

    if (input.mashinadaYetkazildi && !input.mashinaRaqami) {
      throw ApiError.badRequest('mashinadaYetkazildi=true bo\'lsa mashinaRaqami majburiy');
    }

    const id = await runWithTransaction(async (session) => {
      const [doc] = await QurulishSubmissionModel.create(
        [
          {
            category: 'qurulish' as const,
            staffCode: user.code,
            staffName: user.displayName,
            stationId: input.stationId,
            nodeId: input.nodeId,
            ...meta,

            korxonaNomi: input.korxonaNomi ?? '',
            texnikaSoni: Number(input.texnikaSoni) || 0,
            obyekt: input.obyekt ?? '',
            masulShaxs: input.masulShaxs ?? '',
            lavozim: input.lavozim ?? '',
            qanchaOlindi,
            qanchaBerildi,
            dopLimit: roundKg(toDecimal(input.dopLimit)),
            seriya: input.seriya ?? '',
            raqami: input.raqami ?? '',
            poyezdNumber: input.poyezdNumber ?? '',
            ruxsatIndeksi: input.ruxsatIndeksi ?? '',
            poyezdVazni: roundKg(toDecimal(input.poyezdVazni)),
            qoldiq: roundKg(toDecimal(input.qoldiq)),
            buyruqNumber: input.buyruqNumber ?? '',
            kimTomonidan: input.kimTomonidan ?? '',
            buyruqVaqti: input.buyruqVaqti ?? null,
            mashinadaYetkazildi: input.mashinadaYetkazildi ?? false,
            mashinaRaqami: input.mashinaRaqami ?? '',
            limit: 0,
            limitKg: 0,
            excessKg: 0,
            oshiqMiqdor: 0,
            isOverLimit: false,
            approvalId: null,
          },
        ],
        { session },
      );

      const submissionId = String(doc._id);

      if (fuelAmount > 0) {
        await writeFuelRecord(
          {
            submissionId,
            category: 'qurulish',
            stationId: input.stationId,
            nodeId: input.nodeId,
            dateISO: meta.dateISO,
            timestamp: meta.timestamp,
            staffCode: user.code,
            staffName: user.displayName,
            moveType: 'qurulish',
            locoSeries: input.seriya ?? '',
            locoCode: input.raqami ?? '',
            trainIndex: input.ruxsatIndeksi ?? '',
            weight: roundKg(toDecimal(input.poyezdVazni)) || '',
            balanceBeforeKg: roundKg(toDecimal(input.qoldiq)),
            fuelAmountKg: fuelAmount,
          },
          session,
        );

        await summariesService.onCreate(
          {
            dateISO: meta.dateISO,
            year: meta.year,
            stationId: input.stationId,
            nodeId: input.nodeId,
            category: 'qurulish',
            harakatTuri: null,
            fuelKgDelta: fuelAmount,
            maslaKgDelta: 0,
            countDelta: 1,
          },
          session,
        );
      }

      return submissionId;
    });

    broadcastSubmissionChange('created', {
      id,
      category: 'qurulish',
      stationId: input.stationId,
      nodeId: input.nodeId,
      dateISO: meta.dateISO,
    });

    await AuditLogModel.create({
      userId: user.code,
      userName: user.displayName,
      userRole: user.role,
      action: 'create',
      entityType: 'submission',
      entityId: id,
      changes: { qancha: { old: null, new: fuelAmount } },
    });

    return { id, isOverLimit: false, ...meta };
  }

  // ─── Tamirlash ─────────────────────────────────────────────────
  async createTamirlash(input: TamirlashCreateInput, user: JwtPayload) {
    const meta = buildMeta(input.reportDateISO);
    const qanchaBerildi = roundKg(toDecimal(input.qanchaBerildi));
    const dizMasla = roundKg(toDecimal(input.dizMasla));

    if (qanchaBerildi <= 0) throw ApiError.badRequest('qanchaBerildi 0 dan katta bo\'lishi kerak');

    if (input.mashinadaYetkazildi && !input.mashinaRaqami) {
      throw ApiError.badRequest('mashinadaYetkazildi=true bo\'lsa mashinaRaqami majburiy');
    }

    const id = await runWithTransaction(async (session) => {
      const [doc] = await TamirlashSubmissionModel.create(
        [
          {
            category: 'tamirlash' as const,
            staffCode: user.code,
            staffName: user.displayName,
            stationId: input.stationId,
            nodeId: input.nodeId,
            ...meta,

            seriya: input.seriya,
            raqami: input.raqami,
            tamirlashTuri: input.tamirlashTuri,
            qanchaBerildi,
            dizMasla,
            masulShaxs: input.masulShaxs,
            mashinadaYetkazildi: input.mashinadaYetkazildi ?? false,
            mashinaRaqami: input.mashinaRaqami ?? '',
          },
        ],
        { session },
      );

      const submissionId = String(doc._id);

      await writeFuelRecord(
        {
          submissionId,
          category: 'tamirlash',
          stationId: input.stationId,
          nodeId: input.nodeId,
          dateISO: meta.dateISO,
          timestamp: meta.timestamp,
          staffCode: user.code,
          staffName: user.displayName,
          moveType: 'tamirlash',
          locoSeries: input.seriya,
          locoCode: input.raqami,
          trainIndex: `${input.tamirlashTuri} · ${input.masulShaxs}`,
          fuelAmountKg: qanchaBerildi,
          maslaAmountKg: dizMasla,
        },
        session,
      );

      await summariesService.onCreate(
        {
          dateISO: meta.dateISO,
          year: meta.year,
          stationId: input.stationId,
          nodeId: input.nodeId,
          category: 'tamirlash',
          harakatTuri: null,
          fuelKgDelta: qanchaBerildi,
          maslaKgDelta: dizMasla,
          countDelta: 1,
        },
        session,
      );

      return submissionId;
    });

    broadcastSubmissionChange('created', {
      id,
      category: 'tamirlash',
      stationId: input.stationId,
      nodeId: input.nodeId,
      qanchaBerildi,
      dateISO: meta.dateISO,
    });

    await AuditLogModel.create({
      userId: user.code,
      userName: user.displayName,
      userRole: user.role,
      action: 'create',
      entityType: 'submission',
      entityId: id,
      changes: { qanchaBerildi: { old: null, new: qanchaBerildi } },
    });

    return { id, ...meta };
  }

  // ─── List / get ────────────────────────────────────────────────
  async list(query: SubmissionListQuery, user: JwtPayload) {
    const filter: Record<string, unknown> = {};

    // Worker uchun stationId scope
    if (user.role === 'worker') {
      if (!user.stationId) throw ApiError.forbidden('Zapravka biriktirilmagan');
      filter.stationId = user.stationId;
    } else if (query.stationId) {
      filter.stationId = query.stationId;
    }

    if (query.category && query.category !== 'all') {
      filter.category = query.category;
    }

    // Sana filtri
    if (query.dateISO) {
      filter.dateISO = query.dateISO;
    } else if (query.startDate || query.endDate) {
      const dateFilter: Record<string, string> = {};
      if (query.startDate) dateFilter.$gte = query.startDate;
      if (query.endDate) dateFilter.$lte = query.endDate;
      filter.dateISO = dateFilter;
    }

    const [items, total] = await Promise.all([
      SubmissionModel.find(filter)
        .sort({ timestamp: -1 })
        .skip(query.skip)
        .limit(query.limit)
        .lean(),
      SubmissionModel.countDocuments(filter),
    ]);

    return { items, total, skip: query.skip, limit: query.limit };
  }

  /**
   * Update — worker faqat shu kun yozuvini, admin har qachon.
   * Edit delta orqali summaries qayta hisoblanadi.
   */
  async update(id: string, updates: Record<string, unknown>, user: JwtPayload) {
    const existing = await SubmissionModel.findById(id).lean();
    if (!existing) throw ApiError.notFound('Yozuv topilmadi');

    // Worker scope tekshiruvi
    if (user.role === 'worker') {
      if (existing.stationId !== user.stationId) {
        throw ApiError.forbidden('Bu yozuv sizning zapravkangiznikiga tegishli emas');
      }
      if (!isSameDay(existing.timestamp, existing.dateISO)) {
        throw ApiError.forbidden('Yozuv faqat shu kun ichida tahrirlanishi mumkin', 'EDIT_WINDOW_EXPIRED');
      }
      // Worker boshqa kishi yozuvini tahrir qila olmaydi
      if (existing.staffCode !== user.code) {
        throw ApiError.forbidden('Faqat o\'z yozuvingizni tahrir qila olasiz');
      }
    }

    // Decimal normallashtirish — kategoriyaga qarab
    const cat = existing.category as Category;
    const oldFuel = this.extractFuelKg(existing as Record<string, unknown>, cat);
    const oldMasla = this.extractMaslaKg(existing as Record<string, unknown>, cat);

    // Numeric maydonlarni decimal qilib normallashtirish
    const decimalFields = ['qanchaBerildi', 'qancha', 'qanchaOlindi', 'dizMasla', 'qoldiq', 'poyezdVazni'];
    for (const f of decimalFields) {
      if (f in updates) {
        updates[f] = roundKg(toDecimal(updates[f]));
      }
    }

    await runWithTransaction(async (session) => {
      const updated = await SubmissionModel.findByIdAndUpdate(
        id,
        {
          $set: {
            ...updates,
            isEdited: true,
            editedAt: Date.now(),
            editedBy: user.code,
          },
        },
        { new: true, session },
      ).lean();

      if (!updated) throw ApiError.notFound('Yozuv yangilanmadi');

      const newFuel = this.extractFuelKg(updated as Record<string, unknown>, cat);
      const newMasla = this.extractMaslaKg(updated as Record<string, unknown>, cat);

      // Summaries delta
      if (oldFuel !== newFuel || oldMasla !== newMasla) {
        const updatedDoc = updated as unknown as { harakatTuri?: HarakatTuri };

        await summariesService.onUpdate(
          {
            dateISO: existing.dateISO,
            year: existing.year,
            stationId: existing.stationId,
            nodeId: existing.nodeId,
            category: cat,
            harakatTuri: cat === 'lokomotiv' ? (updatedDoc.harakatTuri ?? null) : null,
            oldFuelKg: oldFuel,
            newFuelKg: newFuel,
            oldMaslaKg: oldMasla,
            newMaslaKg: newMasla,
          },
          session,
        );

        // Lokomotiv uchun umumiy summary ham
        if (cat === 'lokomotiv') {
          await summariesService.onUpdate(
            {
              dateISO: existing.dateISO,
              year: existing.year,
              stationId: existing.stationId,
              nodeId: existing.nodeId,
              category: cat,
              harakatTuri: null,
              oldFuelKg: oldFuel,
              newFuelKg: newFuel,
              oldMaslaKg: oldMasla,
              newMaslaKg: newMasla,
            },
            session,
          );
        }

        // Fuel record ham yangilash kerak (eski o'chir, yangi yoz)
        await deleteFuelRecordBySubmission(id, session);
        await writeFuelRecord(
          {
            submissionId: id,
            category: cat,
            stationId: existing.stationId,
            nodeId: existing.nodeId,
            dateISO: existing.dateISO,
            timestamp: existing.timestamp,
            staffCode: existing.staffCode,
            staffName: existing.staffName,
            moveType:
              cat === 'lokomotiv'
                ? ((updatedDoc.harakatTuri as string) ?? 'lokomotiv')
                : cat,
            fuelAmountKg: newFuel,
            maslaAmountKg: newMasla,
          },
          session,
        );
      }
    });

    broadcastSubmissionChange('updated', {
      id,
      category: cat,
      stationId: existing.stationId,
      nodeId: existing.nodeId,
    });

    await AuditLogModel.create({
      userId: user.code,
      userName: user.displayName,
      userRole: user.role,
      action: 'update',
      entityType: 'submission',
      entityId: id,
      changes: updates,
    });

    return { id, ok: true };
  }

  /** Delete — faqat admin */
  async delete(id: string, user: JwtPayload) {
    if (user.role !== 'admin' && user.role !== 'developer') {
      throw ApiError.forbidden('Faqat admin yozuvni o\'chira oladi');
    }
    const existing = await SubmissionModel.findById(id).lean();
    if (!existing) throw ApiError.notFound('Yozuv topilmadi');

    const cat = existing.category as Category;
    const oldFuel = this.extractFuelKg(existing as Record<string, unknown>, cat);
    const oldMasla = this.extractMaslaKg(existing as Record<string, unknown>, cat);
    const harakatTuri = (existing as unknown as { harakatTuri?: HarakatTuri }).harakatTuri ?? null;

    await runWithTransaction(async (session) => {
      await SubmissionModel.findByIdAndDelete(id).session(session ?? null);
      await deleteFuelRecordBySubmission(id, session);

      await summariesService.onDelete(
        {
          dateISO: existing.dateISO,
          year: existing.year,
          stationId: existing.stationId,
          nodeId: existing.nodeId,
          category: cat,
          harakatTuri: cat === 'lokomotiv' ? harakatTuri : null,
          oldFuelKg: oldFuel,
          oldMaslaKg: oldMasla,
        },
        session,
      );

      if (cat === 'lokomotiv') {
        await summariesService.onDelete(
          {
            dateISO: existing.dateISO,
            year: existing.year,
            stationId: existing.stationId,
            nodeId: existing.nodeId,
            category: cat,
            harakatTuri: null,
            oldFuelKg: oldFuel,
            oldMaslaKg: oldMasla,
          },
          session,
        );
      }
    });

    broadcastSubmissionChange('deleted', {
      id,
      category: cat,
      stationId: existing.stationId,
      nodeId: existing.nodeId,
    });

    await AuditLogModel.create({
      userId: user.code,
      userName: user.displayName,
      userRole: user.role,
      action: 'delete',
      entityType: 'submission',
      entityId: id,
      changes: { deleted: { old: existing, new: null } },
    });

    return { ok: true };
  }

  /** Kategoriyaga qarab fuel kg ni ajratish */
  private extractFuelKg(doc: Record<string, unknown>, category: Category): number {
    if (category === 'korxona') return Number(doc.qancha) || 0;
    if (category === 'qurulish') {
      return (Number(doc.qanchaOlindi) || 0) || (Number(doc.qanchaBerildi) || 0);
    }
    return Number(doc.qanchaBerildi) || 0;
  }

  private extractMaslaKg(doc: Record<string, unknown>, _category: Category): number {
    return Number(doc.dizMasla) || 0;
  }
}

export const submissionsService = new SubmissionsService();

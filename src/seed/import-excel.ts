/**
 * Excel import — "Оперативное движение топлива" kunlik fayllarini
 * `submissions` kolleksiyasiga yozadi (SINOV ma'lumoti uchun).
 *
 * Ishga tushirish:
 *   npx ts-node-dev -r tsconfig-paths/register --transpile-only src/seed/import-excel.ts          # yozadi
 *   npx ts-node-dev -r tsconfig-paths/register --transpile-only src/seed/import-excel.ts --dry     # faqat tahlil, yozmaydi
 *
 * Har bir yozilgan hujjat `editedBy: 'excel-import'` markeri bilan belgilanadi.
 * Tozalash (qaytarish):  db.submissions.deleteMany({ editedBy: 'excel-import' })
 * Skript idempotent: qayta yugurtirsa, avval shu marker + sanalarni o'chiradi.
 */

import path from 'path';
import ExcelJS from 'exceljs';
import { connectDB, disconnectDB } from '@/config/db';
import {
  SubmissionModel,
  LokomotivSubmissionModel,
  KorxonaSubmissionModel,
  QurulishSubmissionModel,
} from '@/models';
import { logger } from '@/common/utils/logger';
import { STATIONS } from './stations.data';

const IMPORT_MARKER = 'excel-import';
const DRY = process.argv.includes('--dry');

// Repo ildizidagi fayllar + ularning sanasi (faylnomidagi sana)
const ROOT = path.resolve(__dirname, '../../..');
const FILES: Array<{ file: string; dateISO: string }> = [
  { file: 'spr_day02.06.2026 (2) (2).xlsx', dateISO: '2026-06-02' },
  { file: 'spr_day 03.06.2026й (3) (2).xlsx', dateISO: '2026-06-03' },
];

// ── Stansiya nomi → station lookup ────────────────────────────────
function normName(s: string): string {
  return String(s).toLowerCase().replace(/[`'’ʼ]/g, '').replace(/\s+/g, '');
}
const STATION_BY_NAME = new Map(STATIONS.map((s) => [normName(s.name), s]));

// ── Seriya → rusumi ───────────────────────────────────────────────
const SERIES_MAP: Record<string, string> = {
  '2тэ10м': '2TE10M',
  '3тэ10м': '3TE10M',
  '4тэ10м': '4TE10M',
  'тэм2': 'TEM2',
  'тэм-2': 'TEM2',
  'чмэ-3': 'CHME-3',
  'чмэ3': 'CHME-3',
  'тэп70': 'TEP70',
  'тэп-70': 'TEP70',
};
function mapRusumi(s: string): string {
  const k = String(s).toLowerCase().replace(/\s/g, '');
  return SERIES_MAP[k] ?? (String(s).trim() || '—');
}

type HarakatTuri = 'yuk' | 'yolovchi' | 'manyovr' | 'xojalik' | 'ijara';
type Classified =
  | { category: 'lokomotiv'; harakatTuri: HarakatTuri }
  | { category: 'korxona' }
  | { category: 'qurulish' };

function classify(moveRaw: string, seriesRaw: string): Classified {
  const m = String(moveRaw).toLowerCase().trim();
  if (m.startsWith('предпр')) return { category: 'korxona' };
  if (m.startsWith('строит')) return { category: 'qurulish' };
  if (m.startsWith('манев')) return { category: 'lokomotiv', harakatTuri: 'manyovr' };
  if (m.startsWith('груз')) return { category: 'lokomotiv', harakatTuri: 'yuk' };
  if (m.startsWith('аренд')) return { category: 'lokomotiv', harakatTuri: 'ijara' };
  if (m.startsWith('пасс') || m.startsWith('пригор'))
    return { category: 'lokomotiv', harakatTuri: 'yolovchi' };
  if (m.startsWith('хоз')) return { category: 'lokomotiv', harakatTuri: 'xojalik' };
  // Noma'lum: seriya bo'lsa — ijaraga olingan teplovoz, aks holda korxona
  if (String(seriesRaw).trim()) return { category: 'lokomotiv', harakatTuri: 'ijara' };
  return { category: 'korxona' };
}

// ── Yordamchilar ──────────────────────────────────────────────────
function cellVal(cell: ExcelJS.Cell): unknown {
  let v: unknown = cell.value;
  if (v && typeof v === 'object') {
    const o = v as { result?: unknown; text?: unknown; richText?: Array<{ text: string }> };
    if (o.result !== undefined) v = o.result;
    else if (o.text !== undefined) v = o.text;
    else if (o.richText) v = o.richText.map((t) => t.text).join('');
  }
  return v;
}
function asStr(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}
function asNum(v: unknown): number {
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v ?? '').replace(',', '.').replace(/[^\d.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

interface BuiltDoc {
  category: string;
  [k: string]: unknown;
}

async function parseFile(file: string, dateISO: string) {
  const [y, mo, d] = dateISO.split('-').map(Number);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path.join(ROOT, file));
  const ws = wb.worksheets[0];

  const docs: BuiltDoc[] = [];
  const skipped: string[] = [];
  let current: { station: (typeof STATIONS)[number]; operator: string } | null = null;

  for (let r = 5; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const c1 = cellVal(row.getCell(1));
    const c2 = cellVal(row.getCell(2));
    const c3 = cellVal(row.getCell(3));

    // Guruh sarlavhasi: barcha ustunlar bir xil matn (Stansiya - Operator)
    const isHeader =
      typeof c1 === 'string' && String(c1) === String(c2) && String(c1) === String(c3) && asStr(c1) !== '';
    if (isHeader) {
      const header = asStr(c1);
      const dashIdx = header.indexOf(' - ');
      if (dashIdx === -1) {
        current = null;
        continue;
      }
      const stationName = header.slice(0, dashIdx).trim();
      const operator = header.slice(dashIdx + 3).trim();
      const station = STATION_BY_NAME.get(normName(stationName));
      if (!station) {
        current = null;
        skipped.push(`stansiya topilmadi: "${stationName}" (R${r})`);
        continue;
      }
      current = { station, operator };
      continue;
    }

    // Ma'lumot qatori: 1-ustun vaqt (Date)
    if (!(c1 instanceof Date)) continue;
    if (!current) continue;

    const hh = c1.getUTCHours();
    const mm = c1.getUTCMinutes();
    const ts = new Date(y, mo - 1, d, hh, mm, 0, 0).getTime();

    const series = asStr(c2);
    const raqami = asStr(c3);
    const moveType = asStr(cellVal(row.getCell(4)));
    const trainField = asStr(cellVal(row.getCell(5)));
    const indeks = asStr(cellVal(row.getCell(6)));
    const poyezdVazni = asNum(cellVal(row.getCell(7)));
    const qoldiq = asNum(cellVal(row.getCell(8)));
    const berildi = asNum(cellVal(row.getCell(9)));

    const cls = classify(moveType, series);
    const base = {
      staffCode: current.station.workerCodes[0] ?? '0000',
      staffName: current.operator,
      stationId: current.station.id,
      nodeId: current.station.nodeId,
      timestamp: ts,
      timestampMs: ts,
      dateISO,
      year: y,
      month: mo,
      day: d,
      editedBy: IMPORT_MARKER,
    };

    if (cls.category === 'lokomotiv') {
      const doc: BuiltDoc = {
        ...base,
        category: 'lokomotiv',
        harakatTuri: cls.harakatTuri,
        rusumi: mapRusumi(series),
        lokomotivNumber: raqami || '—',
        poyezdNumber: trainField,
        ruxsatIndeksi: indeks,
        poyezdVazni,
        qoldiq,
        qanchaBerildi: berildi,
        dizMasla: 0,
      };
      if (cls.harakatTuri === 'manyovr') doc.stansiya = trainField;
      else if (cls.harakatTuri === 'xojalik') doc.tashkilot = trainField;
      else if (cls.harakatTuri === 'ijara') doc.ijarachi = trainField;
      docs.push(doc);
    } else if (cls.category === 'korxona') {
      docs.push({
        ...base,
        category: 'korxona',
        korxonaNomi: trainField || 'Predpriyatie',
        poyezdNumber: trainField,
        ruxsatIndeksi: indeks,
        qancha: berildi,
        nechaSutkalik: 1,
      });
    } else {
      docs.push({
        ...base,
        category: 'qurulish',
        korxonaNomi: trainField,
        seriya: series,
        raqami,
        poyezdNumber: trainField,
        ruxsatIndeksi: indeks,
        poyezdVazni,
        qoldiq,
        qanchaOlindi: berildi,
        qanchaBerildi: berildi,
      });
    }
  }

  return { docs, skipped };
}

async function main() {
  logger.info(`Excel import boshlandi ${DRY ? '(DRY — yozilmaydi)' : ''}`);

  const all: BuiltDoc[] = [];
  const dates = new Set<string>();
  for (const { file, dateISO } of FILES) {
    const { docs, skipped } = await parseFile(file, dateISO);
    dates.add(dateISO);
    const byCat = docs.reduce<Record<string, number>>((a, d) => {
      a[d.category] = (a[d.category] ?? 0) + 1;
      return a;
    }, {});
    logger.info(
      `${file} → ${docs.length} qator | ${Object.entries(byCat).map(([k, v]) => `${k}:${v}`).join(', ')}`,
    );
    skipped.forEach((s) => logger.warn('  ' + s));
    all.push(...docs);
  }

  logger.info(`Jami: ${all.length} ta hujjat, sanalar: ${[...dates].join(', ')}`);

  if (DRY) {
    logger.info('DRY rejim — namuna (birinchi 3):');
    console.log(JSON.stringify(all.slice(0, 3), null, 2));
    return;
  }

  await connectDB();

  // Idempotentlik: avvalgi import yozuvlarini shu sanalar uchun o'chiramiz
  const del = await SubmissionModel.deleteMany({
    editedBy: IMPORT_MARKER,
    dateISO: { $in: [...dates] },
  });
  logger.info(`Eski import yozuvlari o'chirildi: ${del.deletedCount}`);

  const lok = all.filter((d) => d.category === 'lokomotiv');
  const kor = all.filter((d) => d.category === 'korxona');
  const qur = all.filter((d) => d.category === 'qurulish');

  if (lok.length) await LokomotivSubmissionModel.insertMany(lok, { ordered: false });
  if (kor.length) await KorxonaSubmissionModel.insertMany(kor, { ordered: false });
  if (qur.length) await QurulishSubmissionModel.insertMany(qur, { ordered: false });

  logger.success(
    `✓ Yozildi — lokomotiv: ${lok.length}, korxona: ${kor.length}, qurulish: ${qur.length}`,
  );

  await disconnectDB();
}

main().catch((e) => {
  logger.error('Import xatosi:', e);
  process.exit(1);
});

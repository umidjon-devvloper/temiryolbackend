import { Schema, model, InferSchemaType, HydratedDocument } from 'mongoose';

/**
 * Staff vault — har bir xodimning to'liq ma'lumoti.
 * tabelNumber — 4 raqamli, butun bazada unique.
 * Login paytida access code → tabelNumber bilan staff topiladi.
 */
const staffSchema = new Schema(
  {
    tabelNumber: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      match: /^[A-Z0-9]{4}$/,
    },
    fullName: { type: String, required: true, trim: true },
    erju: { type: String, required: true, trim: true },     // РЖУ nomi
    zapravka: { type: String, required: true, trim: true }, // Zapravka nomi
    stationId: { type: String, default: null, index: true }, // seed dan keyin resolve qilinadi
    nodeId: { type: String, default: null, index: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  {
    timestamps: true,
    collection: 'staff',
  },
);

staffSchema.index({ fullName: 1 });

export type StaffDoc = HydratedDocument<InferSchemaType<typeof staffSchema>>;
export const StaffModel = model('Staff', staffSchema);

import { Schema, model, InferSchemaType, HydratedDocument } from 'mongoose';

/**
 * Access codes kolleksiyasi — har bir 4 raqamli kod bitta hujjat.
 * staff vault dan ajralib turadi: bu yerda tizimga kirishga ruxsat berilgan
 * kodlar saqlanadi, role va station bog'lanishi bilan.
 */
const userSchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      match: /^[A-Z0-9]{4}$/,
    },
    role: {
      type: String,
      enum: ['worker', 'admin', 'developer'],
      required: true,
      index: true,
    },
    displayName: { type: String, required: true, trim: true },
    nodeId: { type: String, default: null, index: true },
    stationId: { type: String, default: null, index: true },
    codeType: {
      type: String,
      enum: ['main', 'reserve', 'admin', 'developer'],
      required: true,
    },
    isActive: { type: Boolean, default: true, index: true },
  },
  {
    timestamps: true,
    collection: 'users',
  },
);

export type UserDoc = HydratedDocument<InferSchemaType<typeof userSchema>>;
export const UserModel = model('User', userSchema);

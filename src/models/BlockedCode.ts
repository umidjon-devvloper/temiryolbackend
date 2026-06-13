import { Schema, model, InferSchemaType, HydratedDocument } from 'mongoose';

const blockedCodeSchema = new Schema(
  {
    code: { type: String, required: true, unique: true, uppercase: true, match: /^[A-Z0-9]{4}$/ },
    note: { type: String, default: '' },
    blockedAt: { type: Number, default: () => Date.now() },
    blockedBy: { type: String, default: '' },           // admin code
    blockedByDisplayName: { type: String, default: '' },
  },
  {
    timestamps: true,
    collection: 'blocked_codes',
  },
);

export type BlockedCodeDoc = HydratedDocument<InferSchemaType<typeof blockedCodeSchema>>;
export const BlockedCodeModel = model('BlockedCode', blockedCodeSchema);

import { z } from 'zod';

export const loginCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{4}$/, 'Kod 4 ta belgidan (harf yoki raqam) iborat bo\'lishi kerak'),
  deviceId: z.string().min(8, 'Device ID juda qisqa').max(128),
});

export type LoginCodeInput = z.infer<typeof loginCodeSchema>;

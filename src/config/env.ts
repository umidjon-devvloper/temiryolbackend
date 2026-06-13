import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  APP_NAME: z.string().default('temiryol-backend'),

  MONGODB_URI: z.string().min(1, 'MONGODB_URI majburiy'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET kamida 32 belgi bo\'lishi kerak'),
  JWT_EXPIRES_IN: z.string().default('7d'),

  CORS_ORIGINS: z.string().default('http://localhost:3000'),

  MAX_LOGIN_ATTEMPTS: z.coerce.number().int().positive().default(3),
  LOGIN_LOCK_MINUTES: z.coerce.number().int().positive().default(15),

  ALLOW_DATE_OVERRIDE: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  SEED_ADMIN_CODE: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}$/).default('9999'),
  SEED_ADMIN_NAME: z.string().default('Bosh Admin'),
  SEED_DEVELOPER_CODE: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{4}$/).default('9998'),
  SEED_DEVELOPER_NAME: z.string().default('Tizim Boshqaruvchisi'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ .env validatsiyadan o\'tmadi:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = {
  ...parsed.data,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
  isProduction: parsed.data.NODE_ENV === 'production',
  isDevelopment: parsed.data.NODE_ENV === 'development',
};

export type Env = typeof env;

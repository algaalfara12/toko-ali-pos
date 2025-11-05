// packages/api/src/config/env.ts
import { z } from "zod";

function boolFromEnv(val: any, def: boolean) {
  if (val === undefined || val === null) return def;
  const s = String(val).toLowerCase().trim();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return def;
}
function numFromEnv(val: any, def: number) {
  if (val === undefined || val === null) return def;
  const n = Number(val);
  return Number.isFinite(n) ? n : def;
}

export const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  PORT: z.string().optional(),
  DB_PROVIDER: z.enum(["sqlite"]).default("sqlite"),
  DATABASE_URL: z.string(),

  JWT_SECRET: z.string().min(8),
  JWT_EXPIRES: z.string().default("12h"),
  JWT_ISSUER: z.string().default("toko-ali"),
  JWT_AUDIENCE: z.string().default("toko-ali-pos-api"),

  AUDIT_REDACT_KEYS: z
    .string()
    .default("phone,email,cardNumber,secretKey,clientSecret,privateKey"),
  AUDIT_RETENTION_DAYS: z.preprocess(
    (v) => numFromEnv(v, 90),
    z.number().int().min(1)
  ),

  // G4 sebelumnya (opsional)
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default(process.env.NODE_ENV === "production" ? "info" : "debug"),
  LOG_PRETTY: z.preprocess((v) => boolFromEnv(v, false), z.boolean()),
  LOG_SAMPLE: z.preprocess((v) => numFromEnv(v, 1), z.number().min(0).max(1)),

  // === G6 Security/CORS/RateLimit/BodyLimit ===
  CORS_ENABLED: z.preprocess((v) => boolFromEnv(v, true), z.boolean()),
  CORS_ORIGIN: z.string().default("*"), // dev: *, prod: set spesifik origin
  CORS_CREDENTIALS: z.preprocess((v) => boolFromEnv(v, false), z.boolean()),

  RATE_LIMIT_ENABLED: z.preprocess((v) => boolFromEnv(v, true), z.boolean()),
  RATE_LIMIT_MAX: z.preprocess(
    (v) => numFromEnv(v, 300),
    z.number().int().min(1)
  ), // 300 req / window
  RATE_LIMIT_TIME_WINDOW: z.string().default("1m"), // 1 menit

  // (opsional) untuk login route, nanti kalau ingin override per-route
  RATE_LIMIT_AUTH_MAX: z.preprocess(
    (v) => numFromEnv(v, 20),
    z.number().int().min(1)
  ),
  RATE_LIMIT_AUTH_TIME_WINDOW: z.string().default("1m"),

  BODY_LIMIT: z.preprocess(
    (v) => numFromEnv(v, 1_048_576),
    z.number().int().min(1024)
  ), // default 1MB

  TRUST_PROXY: z
    .string()
    .optional()
    .default("false")
    .transform((v) => v === "true"),

  TOMBSTONE_USE_SERVER_TIME: z.preprocess(
    (v) => boolFromEnv(v, true),
    z.boolean()
  ),
  TOMBSTONE_MAX_FUTURE_SKEW_SEC: z.preprocess(
    (v) => numFromEnv(v, 300),
    z.number().int().min(0)
  ),

  TOMBSTONE_RETENTION_ENABLED: z.preprocess(
    (v) => boolFromEnv(v, false),
    z.boolean()
  ),
  TOMBSTONE_RETENTION_DAYS: z.preprocess(
    (v) => numFromEnv(v, 90),
    z.number().int().min(0)
  ),
  TOMBSTONE_STALE_CLIENT_DAYS: z.preprocess(
    (v) => numFromEnv(v, 30),
    z.number().int().min(0)
  ),
  TOMBSTONE_RETENTION_SAFETY_SEC: z.preprocess(
    (v) => numFromEnv(v, 3600),
    z.number().int().min(0)
  ), 
  TOMBSTONE_RETENTION_INTERVAL_MS: z.preprocess(
    (v) => numFromEnv(v, 86_400_000),
    z.number().int().min(10000)
  ),
});

export type AppEnv = z.infer<typeof EnvSchema>;

export function loadEnv(): AppEnv {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid ENV:", parsed.error.flatten());
    process.exit(1);
  }
  return parsed.data;
}

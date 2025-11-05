import fp from "fastify-plugin";
import { FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { loadEnv } from "../config/env";

// helper untuk parsing timeWindow → detik (fallback TTL)
function parseTimeWindowToSec(tw: string | number): number {
  if (typeof tw === "number") return Math.ceil(tw / 1000);
  const m = /^(\d+)\s*(ms|s|m|h)?$/i.exec(tw);
  if (!m) return 10;
  const val = Number(m[1]);
  const unit = (m[2] || "ms").toLowerCase();
  switch (unit) {
    case "ms":
      return Math.ceil(val / 1000);
    case "s":
      return val;
    case "m":
      return val * 60;
    case "h":
      return val * 3600;
    default:
      return 10;
  }
}

export default fp(async function securityPlugin(app: FastifyInstance) {
  const env = loadEnv();

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: "same-origin" },
    referrerPolicy: { policy: "no-referrer" },
  });

  if (env.CORS_ENABLED) {
    // Parse daftar origin dari ENV (bisa koma)
    let originOpt: any = true; // fallback dev: izinkan semua
    if (env.CORS_ORIGIN && env.CORS_ORIGIN !== "*") {
      const arr = env.CORS_ORIGIN.split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      originOpt = arr.length ? arr : true;
    }

    await app.register(cors, {
      origin: originOpt,
      credentials: env.CORS_CREDENTIALS, // false di dev kamu
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "x-device-id"],
      // exposedHeaders: [], // kalau perlu
    });
  }

  if (env.RATE_LIMIT_ENABLED) {
    const twSec = parseTimeWindowToSec(env.RATE_LIMIT_TIME_WINDOW);

    await app.register(rateLimit, {
      global: true,
      max: env.RATE_LIMIT_MAX,
      timeWindow: env.RATE_LIMIT_TIME_WINDOW,
      skipOnError: true,
      allowList: [],
      addHeaders: {
        "x-ratelimit-limit": true,
        "x-ratelimit-remaining": true,
        "x-ratelimit-reset": true,
      },
      addHeadersOnExceeding: {
        "x-ratelimit-remaining": true,
      },

      // builder ini akan dipanggil saat 429 → kita set header Retry-After + body standar
      errorResponseBuilder: (req, context) => {
        const reqId =
          (req.headers["x-request-id"] as string) || (req.id as string);

        // TTL dari plugin dalam ms; fallback ke twSec
        const retryAfterSec = Math.max(
          1,
          Math.ceil((context.ttl ?? twSec * 1000) / 1000)
        );

        // taruh header resmi
        context.reply?.header?.("Retry-After", retryAfterSec.toString());

        // kembalikan objek error (biar tidak diseragamkan ulang)
        return {
          statusCode: 429,
          error: "Too Many Requests",
          code: "RATE_LIMIT",
          message: "Rate limit exceeded",
          retryAfterSec, // ← nilai detik yang benar
          reqId,
        };
      },
    });
  }
});

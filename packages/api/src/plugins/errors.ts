import fp from "fastify-plugin";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ZodError } from "zod";
import { Prisma } from "@prisma/client";

function getReqId(req: FastifyRequest): string {
  return (req.headers["x-request-id"] as string) || (req.id as string);
}

// Prisma guard — mendukung @prisma/client v4/v5
function isPrismaKnownError(e: any): e is Prisma.PrismaClientKnownRequestError {
  return e && typeof e === "object" && e.code && e.clientVersion;
}

// ... import yg sama ...

export default fp(async function errorsPlugin(app: FastifyInstance) {
  app.setNotFoundHandler((req, reply) => {
    const reqId = getReqId(req);
    app.log.warn({ reqId, url: req.url, method: req.method }, "not-found");
    reply.code(404).send({
      ok: false,
      error: {
        code: "NOT_FOUND",
        message: `Route ${req.method} ${req.url} tidak ditemukan`,
      },
      reqId,
    });
  });

  app.setErrorHandler((err: any, req, reply) => {
    const reqId = getReqId(req);

    // 🟦 0) HORMATI RATE LIMIT (429) dari plugin
    if (err && (err.code === "RATE_LIMIT" || err.statusCode === 429)) {
      // Jika plugin rate-limit sudah bentuk respons JSON
      const retryAfterHdr = reply.getHeader?.("Retry-After");
      const retryAfterSec =
        Number(err.retryAfterSec) ||
        (typeof retryAfterHdr === "string"
          ? Number(retryAfterHdr)
          : undefined) ||
        undefined;

      // Pastikan header ikut keluar
      if (retryAfterSec && !retryAfterHdr) {
        reply.header("Retry-After", String(retryAfterSec));
      }

      return reply.code(429).send({
        ok: false,
        error: {
          code: "RATE_LIMIT",
          message: "Rate limit exceeded",
          retryAfterSec: retryAfterSec ?? 0, // fallback 0 jika benar2 tidak ada info
        },
        reqId,
      });
    }

    // 🟦 1) Zod
    if (err instanceof ZodError) {
      app.log.warn({ reqId, err: err.flatten() }, "zod-validation-failed");
      return reply.code(400).send({
        ok: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Validasi input gagal",
          details: err.errors?.map((e) => ({
            path: e.path.join("."),
            message: e.message,
            code: e.code,
          })),
        },
        reqId,
      });
    }

    // 🟦 2) Prisma
    if (isPrismaKnownError(err)) {
      let status = 500;
      let code = `PRISMA_${err.code}`;
      let message = "Kesalahan database";
      if (err.code === "P2002") {
        status = 409;
        code = "DUPLICATE";
        message = "Data sudah ada (unik melanggar)";
      } else if (err.code === "P2025") {
        status = 404;
        code = "RECORD_NOT_FOUND";
        message = "Data yang diminta tidak ditemukan";
      } else if (err.code === "P2003") {
        status = 409;
        code = "FK_CONSTRAINT";
        message = "Gagal karena relasi/foreign key";
      }
      app.log.error({ reqId, code: err.code, meta: err.meta }, "prisma-error");
      return reply
        .code(status)
        .send({ ok: false, error: { code, message }, reqId });
    }

    // 🟦 3) JWT
    if (err && typeof err === "object") {
      const jwtCode = err.code;
      const jwtName = err.name;
      let status = 500,
        code = "INTERNAL_ERROR",
        message = "Terjadi kesalahan pada server";

      if (jwtCode === "FST_JWT_NO_AUTHORIZATION_IN_HEADER") {
        status = 401;
        code = "NO_TOKEN";
        message = "Token tidak ditemukan di header Authorization";
      } else if (jwtName === "TokenExpiredError") {
        status = 401;
        code = "TOKEN_EXPIRED";
        message = "Token sudah kedaluwarsa";
      } else if (jwtName === "JsonWebTokenError") {
        status = 401;
        code = "TOKEN_INVALID";
        message = "Token tidak valid";
      } else if (jwtName === "NotBeforeError") {
        status = 401;
        code = "TOKEN_NOT_ACTIVE";
        message = "Token belum aktif";
      }

      if (status === 401) {
        app.log.warn({ reqId, err }, "jwt-auth-error");
        return reply
          .code(status)
          .send({ ok: false, error: { code, message }, reqId });
      }
    }

    // 🟦 4) fallback
    const status =
      typeof err?.statusCode === "number" && err.statusCode >= 400
        ? err.statusCode
        : 500;
    const message = err?.message || "Terjadi kesalahan pada server";
    const code = err?.code || "INTERNAL_ERROR";

    app.log.error({ reqId, err }, "unhandled-error");
    reply.header("x-request-id", reqId);
    return reply
      .code(status)
      .send({ ok: false, error: { code, message }, reqId });
  });
});

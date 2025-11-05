import { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../prisma";
import { loadEnv } from "../config/env";

export default async function authRoutes(app: FastifyInstance) {
  const env = loadEnv();

  // POST /auth/login
  app.post(
    "/auth/login",
    {
      config: {
        // override per-route rate-limit agar login lebih ketat
        rateLimit: {
          max: env.RATE_LIMIT_AUTH_MAX,
          timeWindow: env.RATE_LIMIT_AUTH_TIME_WINDOW,
          keyGenerator: (req) => {
            const ip = req.ip ?? "unknown";
            let uname = "-";
            try {
              const body = req.body as any;
              if (body && typeof body.username === "string")
                uname = body.username;
            } catch {}
            return `${ip}::${uname}`; // bucket per-IP + username
          },
        },
      },
    },
    async (req, reply) => {
      const schema = z.object({
        username: z.string().min(1),
        password: z.string().min(1),
      });
      const p = schema.safeParse(req.body);
      if (!p.success) {
        return reply.code(400).send({ ok: false, error: p.error.flatten() });
      }

      const { username, password } = p.data;
      const user = await prisma.user.findUnique({ where: { username } });
      if (!user) {
        return reply
          .code(401)
          .send({ ok: false, error: "Invalid credentials" });
      }

      const ok = await bcrypt.compare(password, user.password);
      if (!ok) {
        return reply
          .code(401)
          .send({ ok: false, error: "Invalid credentials" });
      }

      const payload = { id: user.id, username: user.username, role: user.role };
      const token = await app.jwt.sign(payload); // expiry, issuer, audience di-set dari server.ts
      const decoded = app.jwt.decode(token) as any;

      return reply.send({
        ok: true,
        token,
        exp: decoded?.exp ?? null,
        user: payload,
      });
    }
  );

  // GET /auth/me
  app.get("/auth/me", async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ")) {
      return reply.code(401).send({ ok: false, error: "Missing Bearer token" });
    }
    try {
      const token = auth.slice(7);
      const payload = await app.jwt.verify(token);
      return reply.send({ ok: true, user: payload });
    } catch (e: any) {
      const msg = e?.message?.toLowerCase().includes("expired")
        ? "Token expired"
        : "Invalid token";
      return reply.code(401).send({ ok: false, error: msg });
    }
  });
}

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../prisma';

export default async function authRoutes(app: FastifyInstance) {
  // POST /auth/login
  app.post('/auth/login', async (req, reply) => {
    const schema = z.object({
      username: z.string().min(1),
      password: z.string().min(1),
    });
    const p = schema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ ok: false, error: p.error.flatten() });

    const { username, password } = p.data;

    const user = await prisma.user.findUnique({ where: { username } });
    if (!user) return reply.code(401).send({ ok: false, error: 'Username atau password salah' });

    const ok = await app.comparePassword(password, user.password);
    if (!ok) return reply.code(401).send({ ok: false, error: 'Username atau password salah' });

    const token = app.jwt.sign({ id: user.id, username: user.username, role: user.role }, { expiresIn: '12h' });

    return reply.send({
      ok: true,
      token,
      user: { id: user.id, username: user.username, role: user.role },
    });
  });

  // GET /auth/me (butuh bearer token)
  app.get('/auth/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    // req.user diset oleh @fastify/jwt
    return reply.send({ ok: true, user: req.user });
  });
}

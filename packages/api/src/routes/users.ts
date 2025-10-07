import { FastifyInstance } from 'fastify';
import { prisma } from '../prisma';
import { z } from 'zod';
import bcrypt from 'bcryptjs';

const userSchema = z.object({
  username: z.string().min(3),
  password: z.string().min(4),
  role: z.enum(['ADMIN', 'KASIR', 'GUDANG'])
});

export default async function usersRoutes(app: FastifyInstance) {
  // List users
  app.get('/users', async (req, reply) => {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      select: { id: true, username: true, role: true, createdAt: true }
    });
    return reply.send({ ok: true, data: users });
  });

  // Create user
  app.post('/users', async (req, reply) => {
    const p = userSchema.safeParse(req.body);
    if (!p.success) return reply.code(400).send({ ok:false, error: p.error.flatten() });

    const { username, password, role } = p.data;
    const existing = await prisma.user.findUnique({ where: { username } });
    if (existing) return reply.code(409).send({ ok:false, error: 'Username sudah dipakai' });

    const hash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { username, password: hash, role }
    });

    return reply.send({
      ok: true,
      data: { id: user.id, username: user.username, role: user.role, createdAt: user.createdAt }
    });
  });

  // Update (role / password) — optional minimal
  app.patch('/users/:id', async (req, reply) => {
    const id = String((req.params as any).id);
    const body = req.body as any;

    const patchSchema = z.object({
      password: z.string().min(4).optional(),
      role: z.enum(['ADMIN','KASIR','GUDANG']).optional()
    });
    const p = patchSchema.safeParse(body);
    if (!p.success) return reply.code(400).send({ ok:false, error: p.error.flatten() });

    const data: any = {};
    if (p.data.role) data.role = p.data.role;
    if (p.data.password) data.password = await bcrypt.hash(p.data.password, 10);

    const updated = await prisma.user.update({
      where: { id },
      data,
      select: { id: true, username: true, role: true, createdAt: true }
    });

    return reply.send({ ok: true, data: updated });
  });

  // Delete user
  app.delete('/users/:id', async (req, reply) => {
    const id = String((req.params as any).id);
    await prisma.user.delete({ where: { id }});
    return reply.send({ ok: true });
  });

  // Login (token dummy dulu)
  // app.post('/auth/login', async (req, reply) => {
  //   const loginSchema = z.object({
  //     username: z.string().min(1),
  //     password: z.string().min(1),
  //   });
  //   const p = loginSchema.safeParse(req.body);
  //   if (!p.success) return reply.code(400).send({ ok:false, error: p.error.flatten() });

  //   const user = await prisma.user.findUnique({ where: { username: p.data.username } });
  //   if (!user) return reply.code(401).send({ ok:false, error: 'Username atau password salah' });

  //   const ok = await bcrypt.compare(p.data.password, user.password);
  //   if (!ok) return reply.code(401).send({ ok:false, error: 'Username atau password salah' });

  //   // token dummy (nanti ganti JWT)
  //   const token = `DUMMY-${user.id}`;
  //   return reply.send({
  //     ok: true,
  //     token,
  //     user: { id: user.id, username: user.username, role: user.role }
  //   });
  // });
}

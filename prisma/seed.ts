import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

async function hash(pw: string) {
  const saltRounds = 10;
  return bcrypt.hash(pw, saltRounds);
}

async function upsertUser(
  id: string,
  username: string,
  plainPassword: string,
  role: 'admin' | 'kasir' | 'petugas_gudang'
) {
  const password = await hash(plainPassword);
  await prisma.user.upsert({
    where: { id },
    update: { username, password, role },
    create: { id, username, password, role },
  });
}

async function main() {
  // Lokasi
  await prisma.location.upsert({
    where: { code: 'GUDANG' },
    update: {},
    create: { code: 'GUDANG', name: 'Gudang Utama' },
  });
  await prisma.location.upsert({
    where: { code: 'ETALASE' },
    update: {},
    create: { code: 'ETALASE', name: 'Etalase Toko' },
  });
  console.log('Seed OK: lokasi dibuat/ada (GUDANG, ETALASE).');

  // Users
  await upsertUser('admin-1',  'admin',   'admin123',  'admin');
  await upsertUser('kasir-1',  'kasir1',  'kasir123',  'kasir');
  await upsertUser('kasir-2',  'kasir2',  'kasir123',  'kasir');
  await upsertUser('gudang-1', 'gudang',  'gudang123', 'petugas_gudang');

  console.log('Seed OK: users dibuat/diupdate (admin, kasir-1, kasir-2, gudang).');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });

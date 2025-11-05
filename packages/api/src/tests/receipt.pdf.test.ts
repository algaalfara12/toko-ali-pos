// packages/api/src/tests/receipt.pdf.test.ts
import { describe, it, expect, beforeAll } from "vitest";
import { buildApp } from "../app";
import { prisma } from "../prisma";

let app: Awaited<ReturnType<typeof buildApp>>;
let token: string;

beforeAll(async () => {
  app = await buildApp();

  // Buat admin dummy untuk login
  await prisma.user.upsert({
    where: { username: "admin" },
    update: {},
    create: {
      username: "admin",
      // bcryptjs hash untuk "admin123"
      password: "$2a$10$C8WzOrfOdH2Se8pK8cgCyeR5eQzROnpM09eZGrMaGh15EVvh8A5Gi",
      role: "ADMIN",
    },
  });

  // Login → ambil token
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "admin", password: "admin123" },
  });
  const json = res.json();
  token = json.token;
});

describe("PDF Receipt Export", () => {
  it("GET /sales/:id/receipt?export=pdf&paper=58 → PDF response", async () => {
    // Cari sale; jika belum ada, buat dummy minimal
    let sale = await prisma.sale.findFirst();
    if (!sale) {
      sale = await prisma.sale.create({
        data: {
          number: "TEST-0001",
          subtotal: 10000,
          total: 10000,
          createdAt: new Date(),
        },
      });
    }

    // Penting → minta buffer mentah agar kita mendapat res.rawPayload (Buffer)
    const res = await app.inject({
      method: "GET",
      // lebih baik pakai query object supaya aman
      url: `/sales/${sale.id}/receipt`,
      query: { export: "pdf", paper: "58" },
      headers: { authorization: `Bearer ${token}` },
      buffer: true, // <— ini kuncinya agar rawPayload tersedia
    });

    // Debug jika status tidak 200
    if (res.statusCode !== 200) {
      console.error("Non-OK status:", res.statusCode, "Body:", res.body);
    }

    expect(res.statusCode).toBe(200);

    // content-type: bisa "application/pdf" atau "application/octet-stream"
    const ctype = res.headers["content-type"] || "";
    expect(/application\/(pdf|octet-stream)/.test(ctype)).toBeTruthy();

    // Ambil Buffer mentah → rawPayload akan ada jika buffer: true
    const buf: Buffer =
      (res as any).rawPayload ||
      (typeof res.body === "string"
        ? Buffer.from(res.body, "binary")
        : (res.body as any));

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.byteLength).toBeGreaterThan(500); // minimal 500 byte
  });
});

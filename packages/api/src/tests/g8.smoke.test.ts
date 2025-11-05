// packages/api/src/tests/g8.smoke.test.ts
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { buildApp } from "../app";

let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken: string | null = null;

beforeAll(async () => {
  // Matikan rate limit agar test tidak flakey
  process.env.RATE_LIMIT_ENABLED = "false";

  app = await buildApp();

  // Login admin untuk endpoint yang butuh auth
  const res = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { username: "admin", password: "admin123" }, // sesuai seed-mu
    headers: { "x-request-id": "TEST-LOGIN-ADMIN" },
  });

  if (res.statusCode === 200) {
    const body = res.json() as any;
    adminToken = body?.token ?? null;
  }
});

afterAll(async () => {
  await app.close();
});

describe("G8 Smoke Tests", () => {
  it("GET /health → 200 + x-request-id", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { "x-request-id": "TEST-REQ-HEALTH" },
    });

    expect(res.statusCode).toBe(200);

    const payload = res.json();
    expect(payload).toEqual({ ok: true });

    // header harus echo request-id
    expect(res.headers["x-request-id"]).toBe("TEST-REQ-HEALTH");
  });

  it("POST /auth/login (wrong password) → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "admin", password: "SALAH" },
      headers: { "x-request-id": "TEST-REQ-LOGIN-FAIL" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("POST /auth/login (correct) → 200 + token", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username: "admin", password: "admin123" },
      headers: { "x-request-id": "TEST-REQ-LOGIN-OK" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as any;
    expect(body.ok).toBe(true);
    expect(typeof body.token).toBe("string");
  });

  it("GET /sales tanpa token → 401", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/sales?page=1&pageSize=1",
      headers: { "x-request-id": "TEST-REQ-SALES-401" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("GET /sales dengan token admin → 200", async () => {
    expect(adminToken).toBeTruthy();

    const res = await app.inject({
      method: "GET",
      url: "/sales?page=1&pageSize=1",
      headers: {
        Authorization: `Bearer ${adminToken}`,
        "x-request-id": "TEST-REQ-SALES-200",
      },
    });
    expect(res.statusCode).toBe(200);

    // format JSON tergantung route /sales kamu.
    // Minimal: verify response bisa di-parse
    const body = res.json();
    expect(body).toBeTruthy();
  });
});

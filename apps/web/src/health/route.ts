import { NextResponse } from 'next/server';

export const runtime = 'nodejs';           // pastikan pakai Node runtime
export const dynamic = 'force-dynamic';    // biar ga di-cache

export async function GET() {
  try {
    const res = await fetch('http://127.0.0.1:3001/health', { cache: 'no-store' });
    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 500 }
    );
  }
}

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export default async function Page() {
  const res = await fetch('http://127.0.0.1:3001/health', { cache: 'no-store' });
  const data = await res.json();
  return <pre style={{ padding: 24 }}>{JSON.stringify(data, null, 2)}</pre>;
}

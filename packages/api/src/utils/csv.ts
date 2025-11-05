// packages/api/src/utils/csv.ts

/** CSV helper (Excel-friendly): BOM + semicolon ; delimiter */
function csvEscape(v: any) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  // kalau mengandung ; atau " atau newline, bungkus dengan ""
  if (/[;"\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Ubah array of objects → CSV string (delimiter ; + BOM untuk Excel) */
export function toCsv(headers: string[], rows: Array<Record<string, any>>) {
  const head = headers.join(';');
  const body = rows.map(r => headers.map(h => csvEscape(r[h])).join(';')).join('\r\n');
  // BOM untuk Excel (agar Excel auto-UTF8)
  return '\uFEFF' + head + '\r\n' + body + '\r\n';
}

/** Kirim CSV via Fastify reply */
export function sendCsv(reply: any, filename: string, csv: string) {
  reply.header('Content-Type', 'text/csv; charset=utf-8');
  reply.header('Content-Disposition', `attachment; filename="${filename}"`);
  return reply.send(csv);
}

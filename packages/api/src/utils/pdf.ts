// packages/api/src/utils/pdf.ts
import PDFDocument from "pdfkit";
import dayjs from "dayjs";

function toIDR(n: number): string {
  const s = Math.trunc(n);
  return (
    "Rp " +
    s.toLocaleString("id-ID", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })
  );
}

function makeBuffer(doc: PDFDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

// === Helper: konversi mm → point (PDF) ===
const mm = (v: number) => (v * 72) / 25.4;

// === Helper: resolve paper & layout receipt ===
function resolveReceiptPaper(paper?: string) {
  const p = (paper || "A6").toUpperCase();
  if (p === "58") {
    return {
      size: [mm(58), mm(400)], // tinggi awal cukup besar; nanti dipotong
      margins: { top: 6, left: 6, right: 6, bottom: 10 },
      logoW: 24,
      fTitle: 9,
      fText: 7,
      mono: true, // gunakan monospace
    };
  }
  if (p === "80") {
    return {
      size: [mm(80), mm(500)],
      margins: { top: 8, left: 8, right: 8, bottom: 12 },
      logoW: 32,
      fTitle: 10,
      fText: 8,
      mono: true,
    };
  }
  // default A6
  return {
    size: "A6" as any,
    margins: { top: 10, left: 10, right: 10, bottom: 10 },
    logoW: 40,
    fTitle: 10,
    fText: 8,
    mono: false,
  };
}

// === Helper: potong tinggi halaman (khusus thermal) agar tidak ada halaman kosong panjang ===
function cutPageHeight(doc: PDFKit.PDFDocument, bottomPad = 6) {
  const newH = Math.max(doc.y + (bottomPad || 6), 100);
  doc.page.height = newH;
}

// === Helper: hitung kolom berdasarkan lebar halaman & margin ===
function calcReceiptCols(
  doc: PDFKit.PDFDocument,
  margins: { left: number; right: number },
  paperType: string
) {
  const pageW = doc.page.width;
  const contentW = pageW - margins.left - margins.right;
  const gap = 4;

  let qtyW = 0,
    priceW = 0,
    subW = 0;

  if (paperType === "58") {
    qtyW = 10; // sempit
    priceW = 34;
    subW = 40;
  } else if (paperType === "80") {
    qtyW = 22; // sedikit lebih lebar
    priceW = 46;
    subW = 52;
  } else {
    // A6
    qtyW = 30;
    priceW = 50;
    subW = 60;
  }

  // Pastikan sisa untuk nameW tidak negatif
  const consumed = qtyW + priceW + subW + gap * 3;
  const nameW = Math.max(50, contentW - consumed);

  const xName = margins.left;
  const xQty = xName + nameW + gap;
  const xPrice = xQty + qtyW + gap;
  const xSub = xPrice + priceW + gap;

  // Titik kanan konten (untuk patokan right edge)
  const contentRightX = margins.left + contentW;

  return {
    nameX: xName,
    nameW,
    qtyX: xQty,
    qtyW,
    priceX: xPrice,
    priceW,
    subX: xSub,
    subW,
    contentW,
    contentRightX,
    gap,
  };
}

/** =======================
 *  Nota Penjualan (A6 / Thermal 58 / Thermal 80)
 *  ======================= */
export async function buildSaleReceiptPdf(input: {
  storeName: string;
  storeAddress?: string;
  storePhone?: string;
  storeLogoBuffer?: Buffer;
  storeFooterNote?: string;

  saleNumber: string;
  dateTime: Date;
  cashierUsername: string;
  customerName?: string | null;
  customerCode?: string | null;

  items: Array<{
    sku?: string | null;
    name: string;
    uom: string;
    qty: number;
    price: number;
    discount: number;
    subtotal: number;
  }>;
  totals: {
    subtotal: number;
    discountTotal: number;
    tax: number;
    total: number;
    paid: number;
    change: number;
  };
  payments: Array<{
    method: "CASH" | "NON_CASH";
    amount: number;
    ref?: string | null;
  }>;

  paper?: "58" | "80" | "A6"; // ← opsional
}) {
  const opt = resolveReceiptPaper(input.paper);
  const doc = new PDFDocument({
    size: opt.size,
    margins: opt.margins,
  });

  // Gunakan monospace untuk thermal agar alignment stabil
  if (opt.mono) doc.font("Courier");
  let currentY = doc.y;

  // ===== HEADER TOKO =====
  const topY = currentY;
  try {
    if (input.storeLogoBuffer) {
      doc.image(input.storeLogoBuffer, opt.margins.left, topY, {
        width: opt.logoW,
      });
      doc
        .fontSize(opt.fTitle)
        .text(input.storeName, opt.margins.left + opt.logoW + 6, topY + 2);
      let y = topY + 6 + opt.fTitle;
      doc.fontSize(opt.fText);
      if (input.storeAddress) {
        doc.text(input.storeAddress, opt.margins.left + opt.logoW + 6, y, {
          width: 160,
        });
        y += opt.fText + 2;
      }
      if (input.storePhone) {
        doc.text(
          `Tel: ${input.storePhone}`,
          opt.margins.left + opt.logoW + 6,
          y
        );
      }
      currentY = Math.max(doc.y, topY + opt.logoW + 6);
    } else {
      doc.fontSize(opt.fTitle).text(input.storeName, { align: "center" });
      if (input.storeAddress)
        doc.fontSize(opt.fText).text(input.storeAddress, { align: "center" });
      if (input.storePhone)
        doc
          .fontSize(opt.fText)
          .text(`Tel: ${input.storePhone}`, { align: "center" });
      currentY = doc.y;
    }
  } catch {
    doc.fontSize(opt.fTitle).text(input.storeName, { align: "center" });
    if (input.storeAddress)
      doc.fontSize(opt.fText).text(input.storeAddress, { align: "center" });
    if (input.storePhone)
      doc
        .fontSize(opt.fText)
        .text(`Tel: ${input.storePhone}`, { align: "center" });
    currentY = doc.y;
  }
  doc
    .moveTo(opt.margins.left, currentY + 2)
    .lineTo(doc.page.width - opt.margins.right, currentY + 2)
    .stroke();
  currentY += 6;

  // ===== INFO TRANSAKSI =====
  doc.fontSize(opt.fText);
  doc.text(`No   : ${input.saleNumber}`, opt.margins.left, currentY);
  currentY = doc.y;
  doc.text(
    `Tgl  : ${dayjs(input.dateTime).format("YYYY-MM-DD HH:mm")}`,
    opt.margins.left,
    currentY
  );
  currentY = doc.y;
  doc.text(`Kasir: ${input.cashierUsername}`, opt.margins.left, currentY);
  currentY = doc.y;

  if (input.customerName || input.customerCode) {
    doc.text(
      `Cust : ${input.customerName ?? ""}${
        input.customerCode ? ` (${input.customerCode})` : ""
      }`,
      opt.margins.left,
      currentY
    );
    currentY = doc.y;
  }
  doc
    .moveTo(opt.margins.left, currentY + 2)
    .lineTo(doc.page.width - opt.margins.right, currentY + 2)
    .stroke();
  currentY += 6;

  // ===== ITEM HEADER =====
  const cols = calcReceiptCols(doc, opt.margins, input.paper || "A6");
  doc.fontSize(opt.fText);
  doc.text("Item", cols.nameX, currentY, { width: cols.nameW });
  doc.text("Qty", cols.qtyX, currentY);
  doc.text("Harga", cols.priceX, currentY);
  doc.text("Sub", cols.subX, currentY, { width: cols.subW, align: "right" });
  currentY = doc.y;
  doc
    .moveTo(opt.margins.left, currentY + 2)
    .lineTo(doc.page.width - opt.margins.right, currentY + 2)
    .stroke();
  currentY += 4;

  // ===== ITEMS =====
  for (const it of input.items) {
    const nameLine = (it.sku ? `[${it.sku}] ` : "") + it.name + ` (${it.uom})`;
    const nameH = doc.heightOfString(nameLine, { width: cols.nameW });
    const rowH = Math.max(nameH, opt.fText + 6);

    doc.text(nameLine, cols.nameX, currentY, { width: cols.nameW });
    doc.text(String(it.qty), cols.qtyX, currentY);
    doc.text(toIDR(it.price), cols.priceX, currentY);
    doc.text(toIDR(it.subtotal), cols.subX, currentY, {
      width: cols.subW,
      align: "right",
    });

    currentY += rowH;
    doc
      .moveTo(opt.margins.left, currentY)
      .lineTo(doc.page.width - opt.margins.right, currentY)
      .dash(1, { space: 2 })
      .stroke()
      .undash();
    currentY += 4;
  }

  // ===== TOTALS (LABEL : VALUE → ":" lurus) =====
  doc.fontSize(opt.fText + 1);

  // Kita pakai area: [priceX .. (subX - gap)] untuk LABEL, ":" di kolom tetap
  // dan area [subX .. subX+subW] untuk VALUE (right align).
  const labelLeftX = cols.priceX;
  const labelRightX = cols.subX - 2; // tepat sebelum kolom nilai
  const colonX = labelRightX; // ":" berdiri di batas kanan label
  const labelW = Math.max(30, labelRightX - labelLeftX); // antisipasi sempit

  // Helper menggambar 1 baris "Label : Value" selaras
  const drawKV = (label: string, valueText: string) => {
    // label right-aligned
    doc.text(label, labelLeftX, currentY, { width: labelW, align: "right" });
    // colon tepat setelah label
    doc.text(":", colonX, currentY);
    // value right-aligned di kolom nilai
    doc.text(valueText, cols.subX, currentY, {
      width: cols.subW,
      align: "right",
    });
    currentY = doc.y;
  };

  drawKV("Subtotal", toIDR(input.totals.subtotal));
  drawKV("Diskon", toIDR(input.totals.discountTotal));
  if (input.totals.tax) drawKV("Pajak", toIDR(input.totals.tax));
  drawKV("TOTAL", toIDR(input.totals.total));

  currentY += 4;
  drawKV("Bayar", toIDR(input.totals.paid));
  drawKV("Kembali", toIDR(input.totals.change));

  doc
    .moveTo(opt.margins.left, currentY + 2)
    .lineTo(doc.page.width - opt.margins.right, currentY + 2)
    .stroke();
  currentY += 6;

  // ===== PEMBAYARAN DETAIL =====
  doc.fontSize(opt.fText).text("Pembayaran:", opt.margins.left, currentY);
  currentY = doc.y;
  for (const p of input.payments) {
    doc.text(
      `- ${p.method} ${toIDR(p.amount)}${p.ref ? ` (ref: ${p.ref})` : ""}`,
      opt.margins.left,
      currentY
    );
    currentY = doc.y;
  }

  // ===== FOOTER =====
  currentY += 6;
  if (input.storeFooterNote) {
    doc.text(input.storeFooterNote, opt.margins.left, currentY, {
      align: "center",
    });
  } else {
    doc.text("Terima kasih atas kunjungan Anda!", opt.margins.left, currentY, {
      align: "center",
    });
  }
  currentY = doc.y;

  // Potong tinggi halaman (thermal) agar tidak ada blank panjang
  if (input.paper === "58" || input.paper === "80") {
    cutPageHeight(doc, 8);
  }

  return makeBuffer(doc);
}

/** =======================
 *  Closing Kasir Harian (A5)
 *  ======================= */
export async function buildClosingPdf(input: {
  storeName: string;
  dateLabel: string;
  cashierId: string;
  cashierUsername: string;
  createdAt: Date;
  summary: {
    salesCash: number;
    salesNonCash: number;
    salesAll: number;
    items: number;
    refundCash: number;
    refundNonCash: number;
    refundAll: number;
    nettCash: number;
    nettNonCash: number;
    nettAll: number;
  };
  note?: string | null;
  storeLogoBuffer?: Buffer;
}) {
  const doc = new PDFDocument({
    size: "A5",
    margins: { top: 20, left: 20, right: 20, bottom: 20 },
  });

  if (input.storeLogoBuffer) {
    try {
      doc.image(input.storeLogoBuffer, 20, 20, { width: 50 });
      doc.fontSize(14).text(input.storeName, 80, 22);
      doc.fontSize(10).text("Laporan Closing Kasir Harian", 80, 40);
      doc.moveTo(20, 70).lineTo(395, 70).stroke();
      doc.moveDown(2);
    } catch {
      doc.fontSize(14).text(input.storeName, { align: "center" });
      doc
        .fontSize(10)
        .text("Laporan Closing Kasir Harian", { align: "center" });
      doc.moveDown(0.5);
      doc.moveTo(20, doc.y).lineTo(395, doc.y).stroke();
    }
  } else {
    doc.fontSize(14).text(input.storeName, { align: "center" });
    doc.fontSize(10).text("Laporan Closing Kasir Harian", { align: "center" });
    doc.moveDown(0.5);
    doc.moveTo(20, doc.y).lineTo(395, doc.y).stroke();
  }

  doc.moveDown(0.5);
  doc.fontSize(9);
  doc.text(`Tanggal  : ${input.dateLabel}`);
  doc.text(`Kasir    : ${input.cashierUsername} (${input.cashierId})`);
  doc.text(`Dibuat   : ${dayjs(input.createdAt).format("YYYY-MM-DD HH:mm")}`);

  doc.moveDown(0.5);
  doc.moveTo(20, doc.y).lineTo(395, doc.y).stroke();
  doc.moveDown(0.5);
  doc.fontSize(10).text("Ringkasan", { underline: true });

  doc.fontSize(9);
  doc.text(`Penjualan Tunai         : ${toIDR(input.summary.salesCash)}`);
  doc.text(`Penjualan Non-Tunai     : ${toIDR(input.summary.salesNonCash)}`);
  doc.text(`Penjualan TOTAL         : ${toIDR(input.summary.salesAll)}`);
  doc.text(`Item terjual (qty sum)  : ${input.summary.items}`);
  doc.moveDown(0.3);
  doc.text(`Refund Tunai            : ${toIDR(input.summary.refundCash)}`);
  doc.text(`Refund Non-Tunai        : ${toIDR(input.summary.refundNonCash)}`);
  doc.text(`Refund TOTAL            : ${toIDR(input.summary.refundAll)}`);
  doc.moveDown(0.3);
  doc.text(`NETT Tunai              : ${toIDR(input.summary.nettCash)}`);
  doc.text(`NETT Non-Tunai          : ${toIDR(input.summary.nettNonCash)}`);
  doc.text(`NETT TOTAL              : ${toIDR(input.summary.nettAll)}`);

  if (input.note) {
    doc.moveDown(0.5);
    doc.text(`Catatan: ${input.note}`, { width: 355 });
  }

  doc.moveDown(0.8);
  doc.fontSize(8).text("— dicetak otomatis oleh sistem —", { align: "center" });

  return makeBuffer(doc);
}

/** =======================
 *  Nota Retur (A6 / Thermal 58 / Thermal 80)
 *  ======================= */
export async function buildReturnReceiptPdf(input: {
  storeName: string;
  storeAddress?: string;
  storePhone?: string;
  storeFooterNote?: string;
  storeLogoBuffer?: Buffer;

  returnNumber: string;
  returnDateTime: Date;
  returnDateTimeLabel?: string; // jika ada dipakai

  saleNumber: string | null;
  saleDateTime: Date | null;
  saleDateTimeLabel?: string | null; // jika ada dipakai

  cashierUsername: string;

  customerName?: string | null;
  customerCode?: string | null;

  items: Array<{
    sku?: string | null;
    name: string;
    uom: string;
    qty: number;
    price: number;
    subtotal: number;
  }>;
  refunds: Array<{
    method: "CASH" | "NON_CASH";
    amount: number;
    ref?: string | null;
  }>;

  subtotalReturn: number;
  refundTotal: number;

  paper?: "58" | "80" | "A6";
}) {
  const opt = resolveReceiptPaper(input.paper); // ← pakai layout thermal/A6
  const doc = new PDFDocument({
    size: opt.size,
    margins: opt.margins,
  });

  if (opt.mono) doc.font("Courier");
  let currentY = doc.y;

  // ====== HEADER TOKO ======
  const topY = currentY;
  try {
    if (input.storeLogoBuffer) {
      doc.image(input.storeLogoBuffer, opt.margins.left, topY, {
        width: opt.logoW,
      });
      doc
        .fontSize(opt.fTitle)
        .text(input.storeName, opt.margins.left + opt.logoW + 6, topY + 2);
      let y = topY + 6 + opt.fTitle;
      doc.fontSize(opt.fText);
      if (input.storeAddress) {
        doc.text(input.storeAddress, opt.margins.left + opt.logoW + 6, y, {
          width: 160,
        });
        y += opt.fText + 2;
      }
      if (input.storePhone) {
        doc.text(
          `Tel: ${input.storePhone}`,
          opt.margins.left + opt.logoW + 6,
          y
        );
      }
      currentY = Math.max(doc.y, topY + opt.logoW + 6);
    } else {
      doc.fontSize(opt.fTitle).text(input.storeName, { align: "center" });
      if (input.storeAddress)
        doc.fontSize(opt.fText).text(input.storeAddress, { align: "center" });
      if (input.storePhone)
        doc
          .fontSize(opt.fText)
          .text(`Tel: ${input.storePhone}`, { align: "center" });
      currentY = doc.y;
    }
  } catch {
    doc.fontSize(opt.fTitle).text(input.storeName, { align: "center" });
    if (input.storeAddress)
      doc.fontSize(opt.fText).text(input.storeAddress, { align: "center" });
    if (input.storePhone)
      doc
        .fontSize(opt.fText)
        .text(`Tel: ${input.storePhone}`, { align: "center" });
    currentY = doc.y;
  }

  // Garis
  doc
    .moveTo(opt.margins.left, currentY + 2)
    .lineTo(doc.page.width - opt.margins.right, currentY + 2)
    .stroke();
  currentY += 6;

  // ====== TITLE NOTA ======
  doc
    .fontSize(opt.fTitle)
    .text("NOTA RETUR", opt.margins.left, currentY, { align: "center" });
  currentY = doc.y;
  doc
    .moveTo(opt.margins.left, currentY + 2)
    .lineTo(doc.page.width - opt.margins.right, currentY + 2)
    .stroke();
  currentY += 6;

  // ====== INFO RETUR & SALE ======
  doc.fontSize(opt.fText);

  doc.text(`Retur: ${input.returnNumber}`, opt.margins.left, currentY);
  currentY = doc.y;

  const retnLabel =
    input.returnDateTimeLabel ??
    dayjs(input.returnDateTime).format("YYYY-MM-DD HH:mm");
  doc.text(`Tgl  : ${retnLabel}`, opt.margins.left, currentY);
  currentY = doc.y;

  doc.text(`Kasir: ${input.cashierUsername}`, opt.margins.left, currentY);
  currentY = doc.y;

  if (input.saleNumber) {
    const saleLbl =
      input.saleDateTimeLabel ??
      (input.saleDateTime
        ? dayjs(input.saleDateTime).format("YYYY-MM-DD HH:mm")
        : "");
    doc.text(
      `Sale : ${input.saleNumber}${saleLbl ? ` (${saleLbl})` : ""}`,
      opt.margins.left,
      currentY
    );
    currentY = doc.y;
  }

  if (input.customerName || input.customerCode) {
    doc.text(
      `Cust : ${input.customerName ?? ""}${
        input.customerCode ? ` (${input.customerCode})` : ""
      }`,
      opt.margins.left,
      currentY
    );
    currentY = doc.y;
  }

  doc
    .moveTo(opt.margins.left, currentY + 2)
    .lineTo(doc.page.width - opt.margins.right, currentY + 2)
    .stroke();
  currentY += 6;

  // ====== ITEM HEADER ======
  const cols = calcReceiptCols(doc, opt.margins, input.paper || "A6");
  doc.fontSize(opt.fText);
  doc.text("Item", cols.nameX, currentY, { width: cols.nameW });
  doc.text("Qty", cols.qtyX, currentY);
  doc.text("Harga", cols.priceX, currentY);
  doc.text("Sub", cols.subX, currentY, { width: cols.subW, align: "right" });
  currentY = doc.y;
  doc
    .moveTo(opt.margins.left, currentY + 2)
    .lineTo(doc.page.width - opt.margins.right, currentY + 2)
    .stroke();
  currentY += 4;

  // ====== ITEMS ======
  for (const it of input.items) {
    const nameLine = (it.sku ? `[${it.sku}] ` : "") + it.name + ` (${it.uom})`;
    const nameH = doc.heightOfString(nameLine, { width: cols.nameW });
    const rowH = Math.max(nameH, opt.fText + 6);

    doc.text(nameLine, cols.nameX, currentY, { width: cols.nameW });
    doc.text(String(it.qty), cols.qtyX, currentY);
    doc.text(toIDR(it.price), cols.priceX, currentY);
    doc.text(toIDR(it.subtotal), cols.subX, currentY, {
      width: cols.subW,
      align: "right",
    });

    currentY += rowH;
    doc
      .moveTo(opt.margins.left, currentY)
      .lineTo(doc.page.width - opt.margins.right, currentY)
      .dash(1, { space: 2 })
      .stroke()
      .undash();
    currentY += 4;
  }

  // ====== TOTALS (":" align) ======
  doc.fontSize(opt.fText + 1);

  // area label & nilai (sama seperti SALE)
  const labelLeftX = cols.priceX;
  const labelRightX = cols.subX - 2; // tepat sebelum kolom nilai
  const colonX = labelRightX; // ":" di batas kanan label
  const labelW = Math.max(30, labelRightX - labelLeftX);

  const drawKV = (label: string, valueText: string) => {
    doc.text(label, labelLeftX, currentY, { width: labelW, align: "right" });
    doc.text(":", colonX, currentY);
    doc.text(valueText, cols.subX, currentY, {
      width: cols.subW,
      align: "right",
    });
    currentY = doc.y;
  };

  drawKV("Subtotal", toIDR(input.subtotalReturn));
  drawKV("Total", toIDR(input.refundTotal));

  doc
    .moveTo(opt.margins.left, currentY + 2)
    .lineTo(doc.page.width - opt.margins.right, currentY + 2)
    .stroke();
  currentY += 6;

  // ====== RINCIAN REFUND ======
  doc.fontSize(opt.fText).text("Refund:", opt.margins.left, currentY);
  currentY = doc.y;
  for (const r of input.refunds) {
    doc.text(
      `- ${r.method} ${toIDR(r.amount)}${r.ref ? ` (ref: ${r.ref})` : ""}`,
      opt.margins.left,
      currentY
    );
    currentY = doc.y;
  }

  // ====== FOOTER ======
  currentY += 6;
  if (input.storeFooterNote) {
    doc.text(input.storeFooterNote, opt.margins.left, currentY, {
      align: "center",
    });
  } else {
    doc.text(
      "Barang yang sudah diterima kembali tidak dapat diklaim ulang.",
      opt.margins.left,
      currentY,
      {
        align: "center",
      }
    );
  }
  currentY = doc.y;

  // Thermal → potong tinggi
  if (input.paper === "58" || input.paper === "80") {
    cutPageHeight(doc, 8);
  }

  return makeBuffer(doc);
}

/** =======================
 *  Laporan Retur (A4)
 *  ======================= */

export async function buildReturnsReportPdf(input: {
  storeName: string;
  periodLabel: string; // contoh: "2025-10-01 s/d 2025-10-31"
  storeLogoBuffer?: Buffer;
  storeFooterNote?: string;

  rows: Array<{
    number: string;
    createdAt: Date;
    saleNumber?: string | null;
    customerName?: string | null;
    memberCode?: string | null;
    cashierUsername?: string | null;
    locationCode?: string | null;
    locationName?: string | null;
    reason?: string | null;

    items: Array<{
      sku?: string | null;
      name: string;
      uom: string;
      qty: number;
      price: number;
      subtotal: number;
    }>;

    refunds: Array<{
      method: "CASH" | "NON_CASH";
      amount: number;
      ref?: string | null;
    }>;

    subtotal: number;
    refundCash: number;
    refundNonCash: number;
    refundTotal: number;
  }>;
}) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 30, left: 30, right: 30, bottom: 30 },
  });

  // ====== Hitung Ringkasan ======
  const totalReturns = input.rows.length;
  const sumSubtotal = input.rows.reduce(
    (s, r) => s + Number(r.subtotal || 0),
    0
  );
  const sumRefund = input.rows.reduce(
    (s, r) => s + Number(r.refundTotal || 0),
    0
  );

  // Helper: gambar header (logo opsional) + ringkasan, mengembalikan y saat ini
  const drawHeader = () => {
    let yAfter = doc.y;

    const drawHeaderTextCentered = () => {
      doc.fontSize(14).text(input.storeName, { align: "center" });
      doc.fontSize(10).text("Laporan Retur", { align: "center" });
      doc
        .fontSize(9)
        .text(`Periode: ${input.periodLabel}`, { align: "center" });
      doc.moveDown(0.3);
      doc
        .fontSize(9)
        .text(`Jumlah Retur       : ${totalReturns}`, { align: "center" });
      doc.text(`Total Nilai Retur   : ${toIDR(sumSubtotal)}`, {
        align: "center",
      });
      doc.text(`Total Refund (Uang) : ${toIDR(sumRefund)}`, {
        align: "center",
      });
      doc.moveDown(0.5);
      doc.moveTo(30, doc.y).lineTo(565, doc.y).stroke();
      yAfter = doc.y + 10;
    };

    if (input.storeLogoBuffer) {
      try {
        // Header kiri (logo) + kanan (teks)
        doc.image(input.storeLogoBuffer, 30, 30, { width: 50 });
        doc.fontSize(14).text(input.storeName, 90, 32);
        doc.fontSize(10).text("Laporan Retur", 90, 50);
        doc.fontSize(9).text(`Periode: ${input.periodLabel}`, 90, 65);

        // Ringkasan di kanan
        doc.fontSize(9).text(`Jumlah Retur        : ${totalReturns}`, 90, 80);
        doc.text(`Total Nilai Retur    : ${toIDR(sumSubtotal)}`);
        doc.text(`Total Refund (Uang)  : ${toIDR(sumRefund)}`);

        // Garis bawah header
        doc.moveTo(30, 110).lineTo(565, 110).stroke();
        yAfter = 120;
      } catch {
        // Fallback center jika logo gagal di-render
        drawHeaderTextCentered();
      }
    } else {
      // Tanpa logo → header text center
      drawHeaderTextCentered();
    }
    return yAfter;
  };

  let y = drawHeader();

  function ensureSpace(h: number) {
    if (y + h > doc.page.height - 40) {
      doc.addPage();
      y = doc.y + 10;
    }
  }

  // Render tiap retur (detail section)
  for (const r of input.rows) {
    ensureSpace(20);
    doc
      .fontSize(10)
      .text(
        `RETUR: ${r.number} — ${dayjs(r.createdAt).format("YYYY-MM-DD HH:mm")}`,
        30,
        y
      );
    y = doc.y;

    const line1 = `Sale: ${r.saleNumber ?? "-"} | Cashier: ${
      r.cashierUsername ?? "-"
    }`;
    doc.fontSize(9).text(line1, 30, y + 2);
    y = doc.y;

    const line2 =
      `Customer: ${r.customerName ?? "-"}${
        r.memberCode ? ` (${r.memberCode})` : ""
      }` +
      ` | Location: ${r.locationCode ?? "-"}${
        r.locationName ? ` - ${r.locationName}` : ""
      }`;
    doc.text(line2, 30, y + 2);
    y = doc.y;

    if (r.reason) {
      doc.text(`Reason: ${r.reason}`, 30, y + 2);
      y = doc.y;
    }

    // Table header items
    ensureSpace(20);
    doc
      .moveTo(30, y + 6)
      .lineTo(565, y + 6)
      .stroke();
    y += 10;
    doc.fontSize(9);
    const col = { name: 30, uom: 350, qty: 400, price: 450, sub: 520 };
    doc.text("SKU / Nama Barang", col.name, y, { width: 300 });
    doc.text("UOM", col.uom, y);
    doc.text("Qty", col.qty, y);
    doc.text("Harga", col.price, y);
    doc.text("Sub", col.sub, y);
    y += 14;
    doc.moveTo(30, y).lineTo(565, y).stroke();
    y += 4;

    for (const it of r.items) {
      ensureSpace(14);
      const nm = `${it.sku ? `[${it.sku}] ` : ""}${it.name}`;
      doc.fontSize(9).text(nm, col.name, y, { width: 300 });
      doc.text(it.uom, col.uom, y);
      doc.text(String(it.qty), col.qty, y);
      doc.text(toIDR(Number(it.price)), col.price, y);
      doc.text(toIDR(Number(it.subtotal)), col.sub, y);
      y += 14;
    }

    // Footer section per retur: garis
    ensureSpace(10);
    doc
      .moveTo(30, y + 2)
      .lineTo(565, y + 2)
      .stroke();
    y += 8;

    // Subtotal & Refunds
    ensureSpace(14);
    doc.fontSize(9).text(`Subtotal Retur : ${toIDR(r.subtotal)}`, 380, y);
    y = doc.y + 2;

    // Refund breakdown
    ensureSpace(14);
    doc.text(`Refund:`, 30, y);
    y = doc.y + 2;

    const haveRefundLines = r.refunds && r.refunds.length > 0;
    if (haveRefundLines) {
      for (const rf of r.refunds) {
        ensureSpace(12);
        doc.text(
          `- ${rf.method} ${toIDR(rf.amount)}${
            rf.ref ? ` (ref: ${rf.ref})` : ""
          }`,
          40,
          y
        );
        y = doc.y + 1;
      }
    } else {
      ensureSpace(12);
      doc.text(`- (tidak ada refund)`, 40, y);
      y = doc.y + 1;
    }

    // Refund totals
    ensureSpace(14);
    doc.text(`Refund Tunai    : ${toIDR(r.refundCash)}`, 380, y);
    y = doc.y + 2;
    doc.text(`Refund Non-Tunai: ${toIDR(r.refundNonCash)}`, 380, y);
    y = doc.y + 2;
    doc.text(`Refund TOTAL    : ${toIDR(r.refundTotal)}`, 380, y);
    y = doc.y + 6;

    // separator antar retur
    ensureSpace(10);
    doc
      .moveTo(30, y + 2)
      .lineTo(565, y + 2)
      .dash(2, { space: 2 })
      .stroke()
      .undash();
    y += 10;
  }

  // ===== Ringkasan Akhir (di halaman terakhir) =====
  ensureSpace(40);
  doc.moveDown(0.5);
  doc.fontSize(10).text("Ringkasan Periode", 30, y);
  y = doc.y + 2;
  doc.moveTo(30, y).lineTo(565, y).stroke();
  y += 6;

  doc.fontSize(9).text(`Jumlah Retur       : ${totalReturns}`, 30, y);
  y = doc.y + 2;
  doc.text(`Total Nilai Retur   : ${toIDR(sumSubtotal)}`, 30, y);
  y = doc.y + 2;
  doc.text(`Total Refund (Uang) : ${toIDR(sumRefund)}`, 30, y);
  y = doc.y + 8;

  // Footer
  if (input.storeFooterNote) {
    ensureSpace(20);
    doc.moveDown(0.5);
    doc.fontSize(8).text(input.storeFooterNote, { align: "center" });
  } else {
    ensureSpace(20);
    doc.moveDown(0.5);
    doc
      .fontSize(8)
      .text("— dicetak otomatis oleh sistem —", { align: "center" });
  }

  return makeBuffer(doc);
}

/** =======================
 *  Laporan Penjualan (A4)
 *  ======================= */
export async function buildSalesReportPdf(input: {
  storeName: string;
  periodLabel: string; // contoh: "2025-10-01 s/d 2025-10-31"
  storeLogoBuffer?: Buffer;
  storeFooterNote?: string;
  // Ringkasan period
  summary: {
    salesCash: number;
    salesNonCash: number;
    salesAll: number;
    refundCash: number;
    refundNonCash: number;
    refundAll: number;
    nettCash: number;
    nettNonCash: number;
    nettAll: number;
  };
  // Detail sale
  rows: Array<{
    number: string;
    createdAt: Date;
    cashierUsername?: string | null;
    customerName?: string | null;
    memberCode?: string | null;
    // items
    items: Array<{
      sku?: string | null;
      name: string;
      uom: string;
      qty: number;
      price: number;
      discount: number;
      subtotal: number;
    }>;
    payments: { CASH: number; NON_CASH: number };
    total: number; // total sale (header)
  }>;
}) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 30, left: 30, right: 30, bottom: 30 },
  });

  const sum = input.summary;

  const drawHeaderCentered = () => {
    doc.fontSize(14).text(input.storeName, { align: "center" });
    doc.fontSize(10).text("Laporan Penjualan", { align: "center" });
    doc.fontSize(9).text(`Periode: ${input.periodLabel}`, { align: "center" });
    doc.moveDown(0.5);
    doc.moveTo(30, doc.y).lineTo(565, doc.y).stroke();
  };

  // Header dengan logo (seperti laporan retur)
  if (input.storeLogoBuffer) {
    try {
      doc.image(input.storeLogoBuffer, 30, 30, { width: 50 });
      doc.fontSize(14).text(input.storeName, 90, 32);
      doc.fontSize(10).text("Laporan Penjualan", 90, 50);
      doc.fontSize(9).text(`Periode: ${input.periodLabel}`, 90, 65);

      doc.moveTo(30, 80).lineTo(565, 80).stroke();
      doc.y = 90;
    } catch {
      drawHeaderCentered();
      doc.y += 10;
    }
  } else {
    drawHeaderCentered();
    doc.y += 10;
  }

  let y = doc.y;
  function ensureSpace(h: number) {
    if (y + h > doc.page.height - 40) {
      doc.addPage();
      y = doc.y + 10;
    }
  }

  // Loop tiap SALE (blok detail)
  for (const s of input.rows) {
    ensureSpace(20);
    doc
      .fontSize(10)
      .text(
        `SALE: ${s.number} — ${dayjs(s.createdAt).format("YYYY-MM-DD HH:mm")}`,
        30,
        y
      );
    y = doc.y;

    const l1 = `Cashier: ${s.cashierUsername ?? "-"} | Customer: ${
      s.customerName ?? "-"
    }${s.memberCode ? ` (${s.memberCode})` : ""}`;
    doc.fontSize(9).text(l1, 30, y + 2);
    y = doc.y;

    // Table header Items
    ensureSpace(18);
    doc
      .moveTo(30, y + 6)
      .lineTo(565, y + 6)
      .stroke();
    y += 10;
    const col = {
      name: 30,
      uom: 280,
      qty: 330,
      price: 380,
      disc: 430,
      sub: 480,
    };
    doc.fontSize(9).text("SKU / Nama Barang", col.name, y, { width: 300 });
    doc.text("UOM", col.uom, y);
    doc.text("Qty", col.qty, y);
    doc.text("Harga", col.price, y);
    doc.text("Disc", col.disc, y);
    doc.text("SubTotal", col.sub, y, { align: "right" });
    y += 14;
    doc.moveTo(30, y).lineTo(565, y).stroke();
    y += 4;

    for (const it of s.items) {
      ensureSpace(14);
      const nm = `${it.sku ? `[${it.sku}] ` : ""}${it.name}`;
      doc.fontSize(9).text(nm, col.name, y, { width: 300 });
      doc.text(it.uom, col.uom, y);
      doc.text(String(it.qty), col.qty, y);
      doc.text(toIDR(Number(it.price)), col.price, y);
      doc.text(toIDR(Number(it.discount ?? 0)), col.disc, y);
      doc.text(toIDR(Number(it.subtotal)), col.sub, y, { align: "right" });
      y += 14;
    }

    // Footer per SALE: garis + pembayaran breakdown + total sale
    ensureSpace(10);
    doc
      .moveTo(30, y + 2)
      .lineTo(565, y + 2)
      .stroke();
    y += 8;

    ensureSpace(36);
    doc.fontSize(9).text(`Pembayaran:`, 30, y);
    y = doc.y + 2;
    doc.text(`- CASH     : ${toIDR(s.payments.CASH)}`, 40, y);
    y = doc.y + 2;
    doc.text(`- NON_CASH : ${toIDR(s.payments.NON_CASH)}`, 40, y);
    y = doc.y + 2;
    doc.text(`TOTAL SALE : ${toIDR(s.total)}`, 380, y);
    y = doc.y + 6;

    // separator antar SALE
    ensureSpace(10);
    doc
      .moveTo(30, y + 2)
      .lineTo(565, y + 2)
      .dash(2, { space: 2 })
      .stroke()
      .undash();
    y += 10;
  }

  // Ringkasan akhir
  ensureSpace(40);
  doc.moveDown(0.5);
  doc.fontSize(10).text("Ringkasan Periode", 30, y);
  y = doc.y + 2;
  doc.moveTo(30, y).lineTo(565, y).stroke();
  y += 6;

  doc.fontSize(9).text(`Sales CASH      : ${toIDR(sum.salesCash)}`, 30, y);
  y = doc.y + 2;
  doc.text(`Sales NON_CASH  : ${toIDR(sum.salesNonCash)}`, 30, y);
  y = doc.y + 2;
  doc.text(`Sales TOTAL     : ${toIDR(sum.salesAll)}`, 30, y);
  y = doc.y + 6;

  doc.text(`Refund CASH     : ${toIDR(sum.refundCash)}`, 30, y);
  y = doc.y + 2;
  doc.text(`Refund NON_CASH : ${toIDR(sum.refundNonCash)}`, 30, y);
  y = doc.y + 2;
  doc.text(`Refund TOTAL    : ${toIDR(sum.refundAll)}`, 30, y);
  y = doc.y + 6;

  doc.text(`NETT  CASH      : ${toIDR(sum.nettCash)}`, 30, y);
  y = doc.y + 2;
  doc.text(`NETT  NON_CASH  : ${toIDR(sum.nettNonCash)}`, 30, y);
  y = doc.y + 2;
  doc.text(`NETT  TOTAL     : ${toIDR(sum.nettAll)}`, 30, y);
  y = doc.y + 8;

  // Footer
  if (input.storeFooterNote) {
    ensureSpace(20);
    doc.moveDown(0.5);
    doc.fontSize(8).text(input.storeFooterNote, { align: "center" });
  } else {
    ensureSpace(20);
    doc.moveDown(0.5);
    doc
      .fontSize(8)
      .text("— dicetak otomatis oleh sistem —", { align: "center" });
  }

  return makeBuffer(doc);
}

// =======================
//  Laporan Pemasukan (A4)
// =======================
export async function buildInflowReportPdf(input: {
  storeName: string;
  periodLabel: string;
  storeLogoBuffer?: Buffer;
  storeFooterNote?: string;

  rows: Array<{
    cashierUsername: string; // "ALL" atau nama kasir
    salesCash: number;
    salesNonCash: number;
    refundCash: number;
    refundNonCash: number;
    nettCash: number;
    nettNonCash: number;
    nettAll: number;
  }>;
}) {
  // ---- Dokumen
  const doc = new PDFDocument({
    size: "A4", // portrait default
    margins: { top: 30, left: 30, right: 30, bottom: 30 },
  });

  // Helpers
  const pageW = () => doc.page.width;
  const pageH = () => doc.page.height;
  const M = doc.page.margins;
  const contentW = () => pageW() - (M.left + M.right);

  const colPaddingH = 4; // padding horizontal
  const colPaddingV = 4; // padding vertical
  const lineGap = 2;

  // ---- Header Brand
  function drawBrandHeader() {
    const y0 = doc.y;
    if (input.storeLogoBuffer) {
      try {
        doc.image(input.storeLogoBuffer, M.left, y0, { width: 50 });
        doc.fontSize(16).text(input.storeName, M.left + 60, y0 + 2);
        doc
          .fontSize(12)
          .text("Laporan Pemasukan (Cash & Non-Cash)", M.left + 60, y0 + 22);
        doc
          .fontSize(10)
          .text(`Periode: ${input.periodLabel}`, M.left + 60, y0 + 38);
      } catch {
        doc.fontSize(16).text(input.storeName, { align: "center" });
        doc
          .fontSize(12)
          .text("Laporan Pemasukan (Cash & Non-Cash)", { align: "center" });
        doc
          .fontSize(10)
          .text(`Periode: ${input.periodLabel}`, { align: "center" });
      }
    } else {
      doc.fontSize(16).text(input.storeName, { align: "center" });
      doc
        .fontSize(12)
        .text("Laporan Pemasukan (Cash & Non-Cash)", { align: "center" });
      doc
        .fontSize(10)
        .text(`Periode: ${input.periodLabel}`, { align: "center" });
    }
    doc.moveDown(0.3);
    doc
      .moveTo(M.left, doc.y)
      .lineTo(pageW() - M.right, doc.y)
      .stroke();
    doc.moveDown(0.6);
  }

  // ---- Kolom (dinamis)
  // Kolom angka = 7; kolom kasir = 1 (lebih lebar).
  const COLS = [
    { key: "cashier", title: "Kasir" },
    { key: "salesCash", title: "Sales\nCash" },
    { key: "salesNon", title: "Sales\nNon" },
    { key: "refundCash", title: "Refund\nCash" },
    { key: "refundNon", title: "Refund\nNon" },
    { key: "nettCash", title: "Nett\nCash" },
    { key: "nettNon", title: "Nett\nNon" },
    { key: "nettAll", title: "Nett\nTotal" },
  ];

  // Lebar kolom: kasir fleksibel, angka sejajar rata.
  function computeColWidths() {
    const cw = contentW();
    const minName = 140; // minimal lebar kolom kasir
    const nNumCols = COLS.length - 1; // 7
    // sisa untuk kolom angka
    let numColW = Math.floor((cw - minName) / nNumCols);
    if (numColW < 58) {
      // tekan minimal agar tetap muat
      numColW = 58;
    }
    const nameColW = cw - numColW * nNumCols;
    return [nameColW, ...Array(nNumCols).fill(numColW)];
  }
  let widths = computeColWidths();

  // ---- Table Header
  function drawTableHeader(): number {
    const x0 = M.left;
    let x = x0;
    const yHeader = doc.y;
    const headerHeights: number[] = [];

    doc.fontSize(9).font("Helvetica-Bold");

    // Hitung tinggi maksimum header (wrap 2 baris)
    COLS.forEach((c, idx) => {
      const w = widths[idx] - colPaddingH * 2;
      const h = doc.heightOfString(c.title, {
        width: w,
        align: idx === 0 ? "left" : "center",
      });
      headerHeights.push(h);
    });
    const rowH = Math.max(...headerHeights) + colPaddingV * 2;

    // Background header + border bottom
    doc
      .rect(M.left, yHeader, contentW(), rowH)
      .fillOpacity(0.05)
      .fill("#000000")
      .fillOpacity(1);
    doc
      .moveTo(M.left, yHeader + rowH)
      .lineTo(pageW() - M.right, yHeader + rowH)
      .stroke();

    // Teks header
    COLS.forEach((c, idx) => {
      const w = widths[idx];
      const innerX = x + colPaddingH;
      const innerW = w - colPaddingH * 2;
      const align = idx === 0 ? "left" : "center";
      doc
        .fillColor("#000")
        .font("Helvetica-Bold")
        .fontSize(9)
        .text(c.title, innerX, yHeader + colPaddingV, {
          width: innerW,
          align,
          lineGap,
        });
      x += w;
    });

    doc.y = yHeader + rowH + 2;
    return rowH;
  }

  // ---- Baris Data
  function ensurePage(rowH: number): void {
    if (doc.y + rowH > pageH() - M.bottom) {
      doc.addPage();
      drawTableHeader();
    }
  }

  function drawRow(row: any) {
    const x0 = M.left;
    let x = x0;
    const y0 = doc.y;
    doc.font("Helvetica").fontSize(9);

    // Siapkan konten string per kolom:
    const vals = [
      row.cashierUsername || "ALL",
      toIDR(row.salesCash || 0),
      toIDR(row.salesNonCash || 0),
      toIDR(row.refundCash || 0),
      toIDR(row.refundNonCash || 0),
      toIDR(row.nettCash || 0),
      toIDR(row.nettNonCash || 0),
      toIDR(row.nettAll || 0),
    ];

    // Hitung tinggi baris (maks dari setiap cell)
    const heights = vals.map((v, idx) =>
      doc.heightOfString(v, {
        width: widths[idx] - colPaddingH * 2,
        align: idx === 0 ? "left" : "right",
      })
    );
    const rowH = Math.max(...heights) + colPaddingV * 2;

    ensurePage(rowH);

    // garis background strip tipis (optional zebra)
    doc
      .rect(M.left, y0, contentW(), rowH)
      .fillOpacity(0.02)
      .fill("#000000")
      .fillOpacity(1);

    // gambar cell text
    vals.forEach((text, idx) => {
      const w = widths[idx];
      const innerX = x + colPaddingH;
      const innerW = w - colPaddingH * 2;
      const align = idx === 0 ? "left" : "right";
      doc
        .fillColor("#000")
        .fontSize(9)
        .text(text, innerX, y0 + colPaddingV, { width: innerW, align });
      x += w;
    });

    // garis bawah baris
    doc
      .moveTo(M.left, y0 + rowH)
      .lineTo(pageW() - M.right, y0 + rowH)
      .stroke();

    doc.y = y0 + rowH;
  }

  // ---- Footer Grand Total
  function drawGrandTotal(t: {
    salesCash: number;
    salesNonCash: number;
    refundCash: number;
    refundNonCash: number;
    nettCash: number;
    nettNonCash: number;
    nettAll: number;
  }) {
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(11).text("GRAND TOTAL");
    doc.moveDown(0.2);

    const row = {
      cashierUsername: "",
      salesCash: t.salesCash,
      salesNonCash: t.salesNonCash,
      refundCash: t.refundCash,
      refundNonCash: t.refundNonCash,
      nettCash: t.nettCash,
      nettNonCash: t.nettNonCash,
      nettAll: t.nettAll,
    };

    // Render satu baris grand total, tapi label kolom pertama kosong → kita tulis manual:
    const y0 = doc.y;
    const label = "TOTAL";
    const valH = doc.heightOfString(label, {
      width: widths[0] - colPaddingH * 2,
    });
    const rowH = Math.max(valH, 14) + colPaddingV * 2;
    ensurePage(rowH);

    // garis background
    doc
      .rect(M.left, y0, contentW(), rowH)
      .fillOpacity(0.08)
      .fill("#000000")
      .fillOpacity(1);

    // label kolom pertama
    doc
      .fillColor("#000")
      .font("Helvetica-Bold")
      .fontSize(10)
      .text(label, M.left + colPaddingH, y0 + colPaddingV, {
        width: widths[0] - colPaddingH * 2,
      });

    // kolom angka
    const colsNum = [
      toIDR(row.salesCash),
      toIDR(row.salesNonCash),
      toIDR(row.refundCash),
      toIDR(row.refundNonCash),
      toIDR(row.nettCash),
      toIDR(row.nettNonCash),
      toIDR(row.nettAll),
    ];

    let x = M.left + widths[0];
    colsNum.forEach((txt, i) => {
      const w = widths[i + 1];
      doc
        .font("Helvetica-Bold")
        .fontSize(10)
        .text(txt, x + colPaddingH, y0 + colPaddingV, {
          width: w - colPaddingH * 2,
          align: "right",
        });
      x += w;
    });

    doc
      .moveTo(M.left, y0 + rowH)
      .lineTo(pageW() - M.right, y0 + rowH)
      .stroke();
    doc.y = y0 + rowH;
  }

  // ---- Jalankan drawing
  drawBrandHeader();
  widths = computeColWidths();
  drawTableHeader();

  // render rows
  const totals = {
    salesCash: 0,
    salesNonCash: 0,
    refundCash: 0,
    refundNonCash: 0,
    nettCash: 0,
    nettNonCash: 0,
    nettAll: 0,
  };
  for (const r of input.rows) {
    drawRow(r);
    totals.salesCash += Number(r.salesCash || 0);
    totals.salesNonCash += Number(r.salesNonCash || 0);
    totals.refundCash += Number(r.refundCash || 0);
    totals.refundNonCash += Number(r.refundNonCash || 0);
    totals.nettCash += Number(r.nettCash || 0);
    totals.nettNonCash += Number(r.nettNonCash || 0);
    totals.nettAll += Number(r.nettAll || 0);
  }

  drawGrandTotal(totals);

  // return buffer
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

/** ===========================
 *  TOP PRODUCTS (A4, NET only)
 *  =========================== */
export async function buildTopProductsPdf(input: {
  storeName: string;
  periodLabel: string; // contoh: "2025-10-01 s/d 2025-10-31" atau "All Time"
  storeLogoBuffer?: Buffer;
  storeFooterNote?: string;
  sortBy: "qty" | "revenue";
  rows: Array<{
    sku?: string | null;
    name?: string | null;
    baseUom?: string | null;
    qtyBase: number; // NET (sale - return), sudah di-route
    revenue: number; // NET (sale - return)
    // info transparansi (gross/return) — ditampilkan kecil di bawah nama
    saleQtyBase: number;
    returnQtyBase: number;
    saleRevenue: number;
    returnRevenue: number;
  }>;
}) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 30, left: 30, right: 30, bottom: 30 },
  });

  const PAGE_W = doc.page.width;
  const MARGIN_L = 30;
  const MARGIN_R = 30;

  let y = 30;

  // ====== Header dengan logo kiri, teks kanan ======
  const drawHeader = () => {
    const topY = y;
    const logoW = 50;
    let xText = MARGIN_L;

    if (input.storeLogoBuffer) {
      try {
        doc.image(input.storeLogoBuffer, MARGIN_L, topY, { width: logoW });
        xText = MARGIN_L + logoW + 10;
      } catch {
        xText = MARGIN_L;
      }
    }

    doc
      .fontSize(14)
      .text(input.storeName, xText, topY, { width: PAGE_W - MARGIN_R - xText });
    doc.fontSize(10).text("Laporan Top Products (NET)", xText, doc.y + 2);
    doc.fontSize(9).text(`Periode: ${input.periodLabel}`, xText, doc.y + 2);
    doc
      .fontSize(9)
      .text(
        `Sortir: ${
          input.sortBy === "revenue" ? "Omzet tertinggi" : "Kuantitas terbanyak"
        }`,
        xText,
        doc.y + 2
      );

    y = Math.max(topY + 60, doc.y + 10);
    doc
      .moveTo(MARGIN_L, y)
      .lineTo(PAGE_W - MARGIN_R, y)
      .stroke();
    y += 8;
  };

  drawHeader();

  // ===== Tabel =====
  // Column layout (lebar total harus muat)
  const colX = {
    no: MARGIN_L,
    sku: MARGIN_L + 30,
    name: MARGIN_L + 30 + 90,
    qty: MARGIN_L + 30 + 90 + 260,
    rev: MARGIN_L + 30 + 90 + 260 + 70,
  };
  const colW = {
    no: 25,
    sku: 85,
    name: 255,
    qty: 65,
    rev: PAGE_W - MARGIN_R - colX.rev, // sisanya
  };

  const rowPadY = 4;

  function ensureSpace(h: number) {
    const safeBottom = doc.page.height - 40;
    if (y + h > safeBottom) {
      doc.addPage();
      y = 30;
      drawTableHeader();
    }
  }

  function drawTableHeader() {
    doc.fontSize(9).font("Helvetica-Bold");
    doc.text("No", colX.no, y, { width: colW.no, align: "left" });
    doc.text("SKU", colX.sku, y, { width: colW.sku, align: "left" });
    doc.text("Nama Produk", colX.name, y, { width: colW.name, align: "left" });
    doc.text("Qty (NET)", colX.qty, y, { width: colW.qty, align: "right" });
    doc.text("Omzet (NET)", colX.rev, y, { width: colW.rev, align: "right" });

    y += 14;
    doc
      .moveTo(MARGIN_L, y)
      .lineTo(PAGE_W - MARGIN_R, y)
      .stroke();
    y += 4;
  }

  drawTableHeader();

  // ===== Rows
  doc.fontSize(9).font("Helvetica");
  input.rows.forEach((r, i) => {
    ensureSpace(22);

    // Hitung tinggi baris berdasarkan tinggi teks nama (bisa 2 baris kalau panjang),
    // plus satu baris kecil catatan gross/return di bawahnya.
    const nameMain = `${r.name ?? ""}`;
    const nameNote = `(gross: ${Math.round(
      r.saleQtyBase
    )} → return: ${Math.round(r.returnQtyBase)})`;
    const nameMainH = doc.heightOfString(nameMain, { width: colW.name });
    const nameNoteH = doc.heightOfString(nameNote, { width: colW.name });
    const rowH = Math.max(16, nameMainH + nameNoteH + rowPadY);

    const baseY = y;

    // No, SKU, Qty, Revenue ditulis di baseline yang sama
    doc
      .font("Helvetica")
      .text(String(i + 1), colX.no, baseY, { width: colW.no, align: "left" });
    doc.text(r.sku ?? "", colX.sku, baseY, { width: colW.sku, align: "left" });
    doc.text(String(Math.round(r.qtyBase)), colX.qty, baseY, {
      width: colW.qty,
      align: "right",
    });
    doc.text(toIDR(Math.round(r.revenue)), colX.rev, baseY, {
      width: colW.rev,
      align: "right",
    });

    // Nama produk (2 baris: utama + catatan kecil)
    doc.text(nameMain, colX.name, baseY, { width: colW.name, align: "left" });
    doc
      .fontSize(8)
      .fillColor("#444")
      .text(nameNote, colX.name, baseY + nameMainH, {
        width: colW.name,
        align: "left",
      })
      .fillColor("#000")
      .fontSize(9);

    // pindahkan Y ke baris berikut
    y += rowH;

    // garis antar baris
    doc
      .moveTo(MARGIN_L, y)
      .lineTo(PAGE_W - MARGIN_R, y)
      .dash(1, { space: 2 })
      .stroke()
      .undash();
    y += 2;
  });

  // ===== Footer
  y += 8;
  if (input.storeFooterNote) {
    ensureSpace(20);
    doc.fontSize(8).text(input.storeFooterNote, MARGIN_L, y, {
      width: PAGE_W - MARGIN_L - MARGIN_R,
      align: "center",
    });
    y = doc.y + 6;
  } else {
    ensureSpace(20);
    doc.fontSize(8).text("— dicetak otomatis oleh sistem —", MARGIN_L, y, {
      width: PAGE_W - MARGIN_L - MARGIN_R,
      align: "center",
    });
    y = doc.y + 6;
  }

  return makeBuffer(doc);
}

/** ======================================================
 *  TRANSFER REPORT (A4)
 * ====================================================== */
export async function buildTransfersReportPdf(input: {
  storeName: string;
  periodLabel: string;
  storeLogoBuffer?: Buffer;
  storeFooterNote?: string;
  rows: Array<{
    date: string;
    refId: string | null;
    sku: string;
    name: string;
    from?: { code: string; name: string };
    to?: { code: string; name: string };
    uom: string;
    qty: number;
  }>;
}) {
  // ← ubah ke landscape
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 30, left: 30, right: 30, bottom: 30 },
  });

  const PAGE_W = doc.page.width;
  const PAGE_H = doc.page.height;
  const MARGIN_L = 30;
  const MARGIN_R = 30;

  let y = 30;

  /** Header: logo kiri, teks kanan */
  const drawHeader = () => {
    const topY = y;
    const logoW = 50;
    let xText = MARGIN_L;

    if (input.storeLogoBuffer) {
      try {
        doc.image(input.storeLogoBuffer, MARGIN_L, topY, { width: logoW });
        xText = MARGIN_L + logoW + 10;
      } catch {
        xText = MARGIN_L;
      }
    }

    doc.fontSize(14).text(input.storeName, xText, topY, {
      width: PAGE_W - MARGIN_R - xText,
    });
    doc.fontSize(10).text("Laporan Transfer Stok", xText, doc.y + 2);
    doc.fontSize(9).text(`Periode: ${input.periodLabel}`, xText, doc.y + 2);

    y = Math.max(topY + 60, doc.y + 10);
    doc
      .moveTo(MARGIN_L, y)
      .lineTo(PAGE_W - MARGIN_R, y)
      .stroke();
    y += 8;
  };

  drawHeader();

  // ====== Tabel (kolom disesuaikan agar muat di landscape) ======
  // Lebar content ≈ PAGE_W - MARGIN_L - MARGIN_R (~ 842 - 60 = 782 pt)
  // Distribusi (total: 780)
  const colW = {
    date: 70, // Tanggal
    ref: 80, // Ref
    sku: 70, // SKU
    name: 210, // Nama Produk
    from: 135, // Dari
    to: 135, // Ke
    uom: 40, // UOM
    qty: 40, // Qty
  };
  const colX = {
    date: MARGIN_L,
    ref: MARGIN_L + colW.date,
    sku: MARGIN_L + colW.date + colW.ref,
    name: MARGIN_L + colW.date + colW.ref + colW.sku,
    from: MARGIN_L + colW.date + colW.ref + colW.sku + colW.name,
    to: MARGIN_L + colW.date + colW.ref + colW.sku + colW.name + colW.from,
    uom:
      MARGIN_L +
      colW.date +
      colW.ref +
      colW.sku +
      colW.name +
      colW.from +
      colW.to,
    qty:
      MARGIN_L +
      colW.date +
      colW.ref +
      colW.sku +
      colW.name +
      colW.from +
      colW.to +
      colW.uom,
  };

  function ensureSpace(h: number) {
    const safeBottom = doc.page.height - 40;
    if (y + h > safeBottom) {
      doc.addPage();
      y = 30;
      drawHeader();
      drawTableHeader();
    }
  }

  function drawTableHeader() {
    doc.font("Helvetica-Bold").fontSize(9);
    doc.text("Tanggal", colX.date, y, { width: colW.date });
    doc.text("Ref", colX.ref, y, { width: colW.ref });
    doc.text("SKU", colX.sku, y, { width: colW.sku });
    doc.text("Nama", colX.name, y, { width: colW.name });
    doc.text("Dari", colX.from, y, { width: colW.from });
    doc.text("Ke", colX.to, y, { width: colW.to });
    doc.text("UOM", colX.uom, y, { width: colW.uom, align: "center" });
    doc.text("Qty", colX.qty, y, { width: colW.qty, align: "right" });

    y += 14;
    doc
      .moveTo(MARGIN_L, y)
      .lineTo(PAGE_W - MARGIN_R, y)
      .stroke();
    y += 4;
    doc.font("Helvetica").fontSize(9);
  }

  drawTableHeader();

  input.rows.forEach((r) => {
    ensureSpace(24);

    const fromStr = r.from ? `${r.from.code} - ${r.from.name}` : "";
    const toStr = r.to ? `${r.to.code} - ${r.to.name}` : "";

    // Hitung tinggi wrap
    const hName = doc.heightOfString(r.name ?? "", { width: colW.name });
    const hFrom = doc.heightOfString(fromStr, { width: colW.from });
    const hTo = doc.heightOfString(toStr, { width: colW.to });

    const rowH = Math.max(14, hName, hFrom, hTo) + 2;
    const baseY = y;

    // Tulis semua kolom baseline sama (anti tangga)
    doc.text(r.date, colX.date, baseY, { width: colW.date });
    doc.text(r.refId ?? "", colX.ref, baseY, { width: colW.ref });
    doc.text(r.sku ?? "", colX.sku, baseY, { width: colW.sku });
    doc.text(r.name ?? "", colX.name, baseY, { width: colW.name });
    doc.text(fromStr, colX.from, baseY, { width: colW.from });
    doc.text(toStr, colX.to, baseY, { width: colW.to });
    doc.text(r.uom ?? "", colX.uom, baseY, {
      width: colW.uom,
      align: "center",
    });
    doc.text(String(Math.round(r.qty ?? 0)), colX.qty, baseY, {
      width: colW.qty,
      align: "right",
    });

    y += rowH;
    doc
      .moveTo(MARGIN_L, y)
      .lineTo(PAGE_W - MARGIN_R, y)
      .dash(1, { space: 2 })
      .stroke()
      .undash();
    y += 2;
  });

  // Footer
  y += 8;
  if (input.storeFooterNote) {
    ensureSpace(20);
    doc.fontSize(8).text(input.storeFooterNote, MARGIN_L, y, {
      width: PAGE_W - MARGIN_L - MARGIN_R,
      align: "center",
    });
  } else {
    ensureSpace(20);
    doc.fontSize(8).text("— dicetak otomatis oleh sistem —", MARGIN_L, y, {
      width: PAGE_W - MARGIN_L - MARGIN_R,
      align: "center",
    });
  }

  return makeBuffer(doc);
}

// =======================
// Customers List (A4)
// =======================

export async function buildCustomersListPdf(input: {
  storeName: string;
  periodLabel: string; // "SEMUA DATA" atau "2025-10-01 s/d 2025-10-31"
  storeLogoBuffer?: Buffer;
  storeFooterNote?: string;
  showMetrics: boolean; // true jika ada df/dt → tampilkan Tx/Qty/Rp (S/R/N)
  rows: Array<{
    memberCode: string;
    name: string;
    phone: string;
    metrics?: {
      txSale: number;
      txReturn: number;
      txNett: number;
      qtySale: number;
      qtyReturn: number;
      qtyNett: number;
      sales: number;
      refunds: number;
      nett: number;
    };
  }>;
}) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 30, left: 30, right: 30, bottom: 30 },
  });

  // Header
  const drawHeader = () => {
    if (input.storeLogoBuffer) {
      try {
        doc.image(input.storeLogoBuffer, 30, 30, { width: 50 });
        doc.fontSize(14).text(input.storeName, 90, 32);
        doc.fontSize(10).text("Daftar Customer", 90, 50);
        doc.fontSize(9).text(`Periode: ${input.periodLabel}`, 90, 65);
        doc.moveTo(30, 90).lineTo(565, 90).stroke();
      } catch {
        doc.fontSize(14).text(input.storeName, { align: "center" });
        doc.fontSize(10).text("Daftar Customer", { align: "center" });
        doc
          .fontSize(9)
          .text(`Periode: ${input.periodLabel}`, { align: "center" });
        doc.moveDown(0.4);
        doc.moveTo(30, doc.y).lineTo(565, doc.y).stroke();
      }
    } else {
      doc.fontSize(14).text(input.storeName, { align: "center" });
      doc.fontSize(10).text("Daftar Customer", { align: "center" });
      doc
        .fontSize(9)
        .text(`Periode: ${input.periodLabel}`, { align: "center" });
      doc.moveDown(0.4);
      doc.moveTo(30, doc.y).lineTo(565, doc.y).stroke();
    }
  };

  drawHeader();
  let y = 100;

  function ensureSpace(h: number) {
    if (y + h > doc.page.height - 40) {
      doc.addPage();
      drawHeader();
      y = 100;
    }
  }

  // Kolom agar muat (A4 portrait, width ~535)
  // No(24) | Member(80) | Name(150) | Phone(70) | Tx(S/R/N)(64) | Qty(S/R/N)(64) | Rp(S/R/N)(88)
  const col = {
    no: 30,
    member: 54,
    name: 134,
    phone: 284,
    tx: 354,
    qty: 418,
    rp: 482,
  };
  const colWidths = {
    no: 24,
    member: 80,
    name: 150,
    phone: 70,
    tx: 64,
    qty: 64,
    rp: 88,
  };

  // Header tabel
  doc.fontSize(9);
  doc.text("No", col.no, y, { width: colWidths.no });
  doc.text("Member", col.member, y, { width: colWidths.member });
  doc.text("Nama", col.name, y, { width: colWidths.name });
  doc.text("Phone", col.phone, y, { width: colWidths.phone });

  if (input.showMetrics) {
    doc.text("Tx (S/R/N)", col.tx, y, { width: colWidths.tx });
    doc.text("Qty (S/R/N)", col.qty, y, { width: colWidths.qty });
    doc.text("Rp (S/R/N)", col.rp, y, { width: colWidths.rp, align: "right" });
  }

  y += 14;
  doc.moveTo(30, y).lineTo(565, y).stroke();
  y += 4;

  // Body
  let no = 1;
  for (const r of input.rows) {
    ensureSpace(16);

    doc.fontSize(9);
    doc.text(String(no++), col.no, y, { width: colWidths.no });
    doc.text(r.memberCode ?? "", col.member, y, { width: colWidths.member });
    doc.text(r.name ?? "", col.name, y, { width: colWidths.name });
    doc.text(r.phone ?? "", col.phone, y, { width: colWidths.phone });

    if (input.showMetrics && r.metrics) {
      const m = r.metrics;
      doc.text(`${m.txSale}/${m.txReturn}/${m.txNett}`, col.tx, y, {
        width: colWidths.tx,
      });
      doc.text(`${m.qtySale}/${m.qtyReturn}/${m.qtyNett}`, col.qty, y, {
        width: colWidths.qty,
      });
      doc.text(
        `${toIDR(m.sales)}\n${toIDR(m.refunds)}\n${toIDR(m.nett)}`,
        col.rp,
        y,
        {
          width: colWidths.rp,
          align: "right",
        }
      );
    }

    y += input.showMetrics ? 36 : 16;
    doc
      .moveTo(30, y - 4)
      .lineTo(565, y - 4)
      .stroke();
  }

  return makeBuffer(doc);
}

// =======================
// Top Customers (A4)
// =======================

export async function buildTopCustomersPdf(input: {
  storeName: string;
  periodLabel: string; // "SEMUA DATA" atau "YYYY-MM-DD s/d YYYY-MM-DD"
  storeLogoBuffer?: Buffer;
  storeFooterNote?: string;
  rows: Array<{
    rank: number;
    memberCode: string;
    name: string;
    phone: string;
    txSale: number;
    qtyNett: number;
    sales: number;
    refunds: number;
    nett: number;
  }>;
}) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 30, left: 30, right: 30, bottom: 30 },
  });

  // Header
  const drawHeader = () => {
    if (input.storeLogoBuffer) {
      try {
        doc.image(input.storeLogoBuffer, 30, 30, { width: 50 });
        doc.fontSize(14).text(input.storeName, 90, 32);
        doc.fontSize(10).text("Top Customers (Nett)", 90, 50);
        doc.fontSize(9).text(`Periode: ${input.periodLabel}`, 90, 65);
        doc.moveTo(30, 90).lineTo(565, 90).stroke();
      } catch {
        doc.fontSize(14).text(input.storeName, { align: "center" });
        doc.fontSize(10).text("Top Customers (Nett)", { align: "center" });
        doc
          .fontSize(9)
          .text(`Periode: ${input.periodLabel}`, { align: "center" });
        doc.moveDown(0.4);
        doc.moveTo(30, doc.y).lineTo(565, doc.y).stroke();
      }
    } else {
      doc.fontSize(14).text(input.storeName, { align: "center" });
      doc.fontSize(10).text("Top Customers (Nett)", { align: "center" });
      doc
        .fontSize(9)
        .text(`Periode: ${input.periodLabel}`, { align: "center" });
      doc.moveDown(0.4);
      doc.moveTo(30, doc.y).lineTo(565, doc.y).stroke();
    }
  };

  drawHeader();
  let y = 100;
  function ensureSpace(h: number) {
    if (y + h > doc.page.height - 40) {
      doc.addPage();
      drawHeader();
      y = 100;
    }
  }

  // Kolom (A4 portrait):
  // Rank(26) | Member(80) | Name(160) | Phone(80) | Tx(50) | QtyNett(60) | Nett(70)
  const col = {
    rank: 30,
    member: 56,
    name: 136,
    phone: 296,
    tx: 376,
    qty: 426,
    nett: 486,
  };
  const colWidths = {
    rank: 26,
    member: 80,
    name: 160,
    phone: 80,
    tx: 50,
    qty: 60,
    nett: 70,
  };

  // Header tabel
  doc.fontSize(9);
  doc.text("No", col.rank, y, { width: colWidths.rank });
  doc.text("Member", col.member, y, { width: colWidths.member });
  doc.text("Nama", col.name, y, { width: colWidths.name });
  doc.text("Phone", col.phone, y, { width: colWidths.phone });
  doc.text("Tx", col.tx, y, { width: colWidths.tx });
  doc.text("QtyNett", col.qty, y, { width: colWidths.qty });
  doc.text("Nett", col.nett, y, { width: colWidths.nett, align: "right" });

  y += 14;
  doc.moveTo(30, y).lineTo(565, y).stroke();
  y += 4;

  // Body
  for (const r of input.rows) {
    ensureSpace(16);
    doc.fontSize(9);
    doc.text(String(r.rank), col.rank, y, { width: colWidths.rank });
    doc.text(r.memberCode ?? "", col.member, y, { width: colWidths.member });
    doc.text(r.name ?? "", col.name, y, { width: colWidths.name });
    doc.text(r.phone ?? "", col.phone, y, { width: colWidths.phone });
    doc.text(String(r.txSale), col.tx, y, { width: colWidths.tx });
    doc.text(String(r.qtyNett), col.qty, y, { width: colWidths.qty });
    doc.text(toIDR(r.nett), col.nett, y, {
      width: colWidths.nett,
      align: "right",
    });

    y += 16;
    doc
      .moveTo(30, y - 4)
      .lineTo(565, y - 4)
      .stroke();
  }

  return makeBuffer(doc);
}

/* ======================================================================================
 *  PURCHASE SLIP (PDF)
 *  ====================================================================================== */
export async function buildPurchaseSlipPdf(input: {
  storeName: string;
  storeLogoBuffer?: Buffer;
  storeAddress?: string;
  storePhone?: string;
  storeFooterNote?: string;

  number: string;
  createdAt: Date;
  supplier?: {
    name?: string | null;
    phone?: string | null;
    address?: string | null;
  } | null;
  location?: { code?: string | null; name?: string | null } | null;
  note?: string | null;

  lines: Array<{
    sku?: string | null;
    name?: string | null;
    uom: string;
    qty: number;
    buyPrice: number;
    sellPrice?: number | null;
    subtotal: number;
  }>;

  subtotal: number;
  discount: number;
  total: number;
}) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 30, left: 30, right: 30, bottom: 30 },
  });

  const left = doc.page.margins.left; // 30
  const right = doc.page.width - doc.page.margins.right; // 565
  const usable = right - left; // ~535

  /* ===== HEADER (fix overlap logo vs teks) ===== */
  const yTop = doc.y; // biasanya 30
  const logoW = 50;
  let yAfterHeader = yTop;

  // Left block: logo
  if (input.storeLogoBuffer) {
    try {
      doc.image(input.storeLogoBuffer, left, yTop, { width: logoW });
    } catch {}
  }

  // Right of logo: title & store info
  const textX = input.storeLogoBuffer ? left + logoW + 10 : left;
  const blockWidth = right - textX;

  doc.fontSize(14).text(input.storeName, textX, yTop, { width: blockWidth });
  doc.fontSize(10);
  if (input.storeAddress)
    doc.text(input.storeAddress, textX, doc.y, { width: blockWidth });
  if (input.storePhone)
    doc.text(`Telp: ${input.storePhone}`, textX, doc.y, { width: blockWidth });

  // Hitung ketinggian blok teks & logo → tentukan y setelah header
  const textHeight = doc.y - yTop;
  const logoHeight = input.storeLogoBuffer ? 50 : 0;
  yAfterHeader = yTop + Math.max(textHeight, logoHeight);
  doc.y = yAfterHeader + 8;

  doc.fontSize(12).text("SLIP PEMBELIAN", { align: "center" });
  doc
    .moveTo(left, doc.y + 4)
    .lineTo(right, doc.y + 4)
    .stroke();
  doc.moveDown(0.8);

  // Info purchase
  doc.fontSize(9);
  const tanggal = dayjs(input.createdAt).format("YYYY-MM-DD HH:mm");
  doc.text(`Nomor     : ${input.number}`, left, doc.y);
  doc.text(`Tanggal   : ${tanggal}`, left, doc.y);
  const supplierLabel = input.supplier?.name
    ? `${input.supplier.name}${
        input.supplier.phone ? ` (HP: ${input.supplier.phone})` : ""
      }`
    : "-";
  doc.text(`Supplier  : ${supplierLabel}`, left, doc.y);
  const locLabel = input.location?.code
    ? `${input.location.code}${
        input.location?.name ? ` - ${input.location.name}` : ""
      }`
    : "-";
  doc.text(`Lokasi    : ${locLabel}`, left, doc.y);
  if (input.note) {
    doc.moveDown(0.3);
    doc.text(`Catatan   : ${input.note}`, left, doc.y, { width: usable });
  }

  doc.moveDown(0.4);
  doc.moveTo(left, doc.y).lineTo(right, doc.y).stroke();

  /* ===== TABLE (anti-tangga) ===== */
  // Kolom diusahakan muat di usable=~535
  // No(25) | SKU(80) | Nama(~250 wrap) | UOM(45) | Qty(50r) | HrgBeli(85r) | Subtotal(100r)
  const col = {
    no: left + 0,
    sku: left + 30,
    name: left + 120,
    uom: left + 280,
    qty: left + 300,
    buy: left + 360,
    sub: left + 420, // right - 100
  };
  const nameWidth = col.uom - col.name - 10; // sekitar 250
  const lineH = 14;

  // Header table
  const headerY = doc.y + 6;
  doc.fontSize(9);
  doc.text("No", col.no, headerY, { width: 25 });
  doc.text("SKU", col.sku, headerY, { width: 80 });
  doc.text("Nama", col.name, headerY, { width: nameWidth });
  doc.text("UOM", col.uom, headerY, { width: 45 });
  doc.text("Qty", col.qty, headerY, { width: 50, align: "right" });
  doc.text("Harga Beli", col.buy, headerY, { width: 85, align: "right" });
  doc.text("Subtotal", col.sub, headerY, { width: 100, align: "right" });

  doc
    .moveTo(left, headerY + lineH - 3)
    .lineTo(right, headerY + lineH - 3)
    .stroke();
  let y = headerY + lineH;

  // Render tiap row dengan tinggi terukur (menghindari tangga)
  let idx = 1;
  for (const it of input.lines) {
    // Hitung tinggi nama
    const nm = it.name ?? "";
    const nameHeight = doc.heightOfString(nm, {
      width: nameWidth,
      align: "left",
    });
    const rowH = Math.max(lineH, nameHeight + 2);

    // Jika melewati halaman -> addPage header ulang (opsional: sederhana dulu)
    if (y + rowH > doc.page.height - doc.page.margins.bottom - 60) {
      doc.addPage();
      y = doc.page.margins.top;
      // (opsional) gambar header table ulang
      const hY = y;
      doc.fontSize(9);
      doc.text("No", col.no, hY, { width: 25 });
      doc.text("SKU", col.sku, hY, { width: 80 });
      doc.text("Nama", col.name, hY, { width: nameWidth });
      doc.text("UOM", col.uom, hY, { width: 45 });
      doc.text("Qty", col.qty, hY, { width: 50, align: "right" });
      doc.text("Harga Beli", col.buy, hY, { width: 85, align: "right" });
      doc.text("Subtotal", col.sub, hY, { width: 100, align: "right" });
      doc
        .moveTo(left, hY + lineH - 3)
        .lineTo(right, hY + lineH - 3)
        .stroke();
      y = hY + lineH;
    }

    // Tulis setiap kolom memakai y yang sama
    doc.fontSize(9);
    doc.text(String(idx), col.no, y, { width: 25 });
    doc.text(it.sku ?? "", col.sku, y, { width: 80 });

    // Nama wrap
    doc.text(nm, col.name, y, { width: nameWidth });
    // Kolom kecil rata satu baris
    doc.text(it.uom, col.uom, y, { width: 45 });
    doc.text(String(it.qty), col.qty, y, { width: 50, align: "right" });
    doc.text(toIDR(Number(it.buyPrice)), col.buy, y, {
      width: 85,
      align: "right",
    });
    doc.text(toIDR(Number(it.subtotal)), col.sub, y, {
      width: 100,
      align: "right",
    });

    // Garis row
    doc
      .moveTo(left, y + rowH)
      .lineTo(right, y + rowH)
      .stroke();
    y += rowH;
    idx++;
  }

  // Totals di kanan
  doc.moveDown(0.5);
  const totX = right - 220;
  doc.fontSize(10);
  doc.text(`Subtotal : ${toIDR(input.subtotal)}`, totX, y + 8, {
    width: 220,
    align: "right",
  });
  doc.text(`Diskon   : ${toIDR(input.discount)}`, totX, doc.y, {
    width: 220,
    align: "right",
  });
  doc.text(`TOTAL    : ${toIDR(input.total)}`, totX, doc.y, {
    width: 220,
    align: "right",
  });

  return makeBuffer(doc);
}

/* ======================================================================================
 *  PO PREVIEW (PDF) — tanpa harga
 *  ====================================================================================== */
export async function buildPurchaseOrderPreviewPdf(input: {
  storeName: string;
  storeLogoBuffer?: Buffer;
  storeAddress?: string;
  storePhone?: string;
  storeFooterNote?: string;

  supplier?: {
    name?: string | null;
    phone?: string | null;
    address?: string | null;
  } | null;
  expectedDate?: Date | null;
  note?: string | null;

  lines: Array<{
    sku?: string | null;
    name?: string | null;
    uom: string;
    qty: number;
  }>;
}) {
  const doc = new PDFDocument({
    size: "A4",
    margins: { top: 30, left: 30, right: 30, bottom: 30 },
  });

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const usable = right - left;

  // Header (rapih & no overlap)
  const yTop = doc.y;
  const logoW = 50;
  let yAfterHeader = yTop;

  if (input.storeLogoBuffer) {
    try {
      doc.image(input.storeLogoBuffer, left, yTop, { width: logoW });
    } catch {}
  }
  const textX = input.storeLogoBuffer ? left + logoW + 10 : left;
  const blockWidth = right - textX;

  doc.fontSize(14).text(input.storeName, textX, yTop, { width: blockWidth });
  doc
    .fontSize(12)
    .text("PURCHASE ORDER (PREVIEW)", textX, doc.y + 2, { width: blockWidth });

  const textHeight = doc.y - yTop;
  const logoHeight = input.storeLogoBuffer ? 50 : 0;
  yAfterHeader = yTop + Math.max(textHeight, logoHeight);
  doc.y = yAfterHeader + 8;

  doc.moveTo(left, doc.y).lineTo(right, doc.y).stroke();
  doc.moveDown(0.4);
  doc.fontSize(9);
  if (input.supplier?.name) {
    doc.text(
      `Supplier : ${input.supplier.name}${
        input.supplier.phone ? ` (HP: ${input.supplier.phone})` : ""
      }`,
      left,
      doc.y,
      { width: usable }
    );
  } else {
    doc.text(`Supplier : -`, left, doc.y, { width: usable });
  }
  if (input.expectedDate) {
    const ed = dayjs(input.expectedDate).format("YYYY-MM-DD");
    doc.text(`Estimasi : ${ed}`, left, doc.y);
  }
  if (input.note) {
    doc.moveDown(0.3);
    doc.text(`Catatan  : ${input.note}`, { width: usable });
  }

  doc.moveDown(0.4);
  doc.moveTo(left, doc.y).lineTo(right, doc.y).stroke();

  // Table tanpa harga
  const col = {
    no: left + 0,
    sku: left + 30,
    name: left + 120,
    uom: left + 300,
    qty: left + 400,
  };
  const nameWidth = col.uom - col.name - 10;
  const lineH = 14;

  const headerY = doc.y + 6;
  doc.fontSize(9);
  doc.text("No", col.no, headerY, { width: 25 });
  doc.text("SKU", col.sku, headerY, { width: 80 });
  doc.text("Nama", col.name, headerY, { width: nameWidth });
  doc.text("UOM", col.uom, headerY, { width: 60 });
  doc.text("Qty", col.qty, headerY, { width: 60, align: "right" });
  doc
    .moveTo(left, headerY + lineH - 3)
    .lineTo(right, headerY + lineH - 3)
    .stroke();

  let y = headerY + lineH;
  let idx = 1;
  for (const it of input.lines) {
    const nm = it.name ?? "";
    const nameHeight = doc.heightOfString(nm, { width: nameWidth });
    const rowH = Math.max(lineH, nameHeight + 2);

    if (y + rowH > doc.page.height - doc.page.margins.bottom - 60) {
      doc.addPage();
      y = doc.page.margins.top;

      const hY = y;
      doc.fontSize(9);
      doc.text("No", col.no, hY, { width: 25 });
      doc.text("SKU", col.sku, hY, { width: 80 });
      doc.text("Nama", col.name, hY, { width: nameWidth });
      doc.text("UOM", col.uom, hY, { width: 60 });
      doc.text("Qty", col.qty, hY, { width: 60, align: "right" });
      doc
        .moveTo(left, hY + lineH - 3)
        .lineTo(right, hY + lineH - 3)
        .stroke();

      y = hY + lineH;
    }

    doc.fontSize(9);
    doc.text(String(idx), col.no, y, { width: 25 });
    doc.text(it.sku ?? "", col.sku, y, { width: 80 });
    doc.text(nm, col.name, y, { width: nameWidth });
    doc.text(it.uom, col.uom, y, { width: 60 });
    doc.text(String(it.qty), col.qty, y, { width: 60, align: "right" });

    doc
      .moveTo(left, y + rowH)
      .lineTo(right, y + rowH)
      .stroke();
    y += rowH;
    idx++;
  }

  doc.moveDown(0.8);
  return makeBuffer(doc);
}

// =================================
//  STOCK SUMMARY (A4 Landscape)
//  Kolom tetap: Gudang → Etalase → Total
// =================================
export async function buildStockSummaryPdf(input: {
  storeName: string;
  periodLabel: string;
  storeLogoBuffer?: Buffer;
  storeFooterNote?: string;
  colAName: string; // label kolom1 (pivot A), ex: "GUDANG"
  colBName: string; // label kolom2 (pivot B), ex: "ETALASE"
  rows: Array<{
    sku?: string | null;
    name?: string | null;
    baseUom?: string | null;
    qtyGudang: number; // nilai untuk pivot A
    qtyEtalase: number; // nilai untuk pivot B
    qtyTotal: number;
  }>;
}) {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 30, left: 30, right: 30, bottom: 30 },
  });

  const page = () => doc.page;
  const LEFT = 40;
  const RIGHT = 800;
  const BOTTOM_LIMIT = () => page().height - page().margins.bottom - 20;

  /** Header fix — posisi absolut, tidak mengandalkan doc.y */
  const drawHeader = () => {
    const topY = page().margins.top; // 30
    const logoW = 60;
    const titleX = LEFT + logoW + 10;
    let headerBottom = topY;

    // Logo (opsional)
    if (input.storeLogoBuffer) {
      try {
        doc.image(input.storeLogoBuffer, LEFT, topY, { width: logoW });
        headerBottom = Math.max(headerBottom, topY + logoW);
      } catch {
        // jika gagal render logo, abaikan
      }
    }

    // Judul
    doc.fontSize(16).text(input.storeName, titleX, topY);
    doc.fontSize(11).text("Laporan Stok (Summary)", titleX, topY + 18);
    doc.fontSize(10).text(input.periodLabel, titleX, topY + 34);

    // Pastikan garis bawah header dan starting Y tabel
    const lineY = Math.max(headerBottom, topY + 60);
    doc.moveTo(LEFT, lineY).lineTo(RIGHT, lineY).stroke();

    // Set posisi awal tabel
    const tableStartY = lineY + 15;
    doc.y = tableStartY;
    return tableStartY;
  };

  /** Footer — dipanggil sekali di akhir */
  const drawFooter = () => {
    const footerText =
      input.storeFooterNote ?? "— dicetak otomatis oleh sistem —";
    const footerY = page().height - page().margins.bottom + 5; // tepat di bawah area konten
    doc.fontSize(8).text(footerText, LEFT, footerY, {
      width: RIGHT - LEFT,
      align: "center",
    });
  };

  /** Header tabel — pastikan jarak vertikal aman */
  const drawTableHeader = () => {
    doc.font("Helvetica-Bold").fontSize(9);
    const col = {
      sku: LEFT,
      name: LEFT + 120, // 80
      baseUom: LEFT + 380,
      colA: LEFT + 480, // label = input.colAName
      colB: LEFT + 580, // label = input.colBName
      total: LEFT + 680,
    };
    const nameWidth = col.baseUom - 10 - col.name; // ~ 480 - 10 - 120

    // Tulis header kolom
    const y0 = doc.y;
    doc.text("SKU", col.sku, y0);
    doc.text("Nama Barang", col.name, y0, { width: nameWidth });
    doc.text("Base UOM", col.baseUom, y0);
    doc.text(input.colAName, col.colA, y0, { width: 80, align: "right" });
    doc.text(input.colBName, col.colB, y0, { width: 80, align: "right" });
    doc.text("Total", col.total, y0, { width: 60, align: "right" });

    // Garis bawah header tabel
    const lineY = y0 + 14;
    doc.moveTo(LEFT, lineY).lineTo(RIGHT, lineY).stroke();

    // Posisi awal isi
    doc.y = lineY + 6;

    // Kembalikan definisi kolom dan width yang digunakan
    return { col, nameWidth };
  };

  /** Pastikan halaman baru bila baris tak muat */
  const ensurePage = (rowHeight: number) => {
    if (doc.y + rowHeight > BOTTOM_LIMIT()) {
      doc.addPage({ size: "A4", layout: "landscape" });
      drawHeader();
      drawTableHeader();
      doc.font("Helvetica").fontSize(9);
    }
  };

  const num = (x: number) => String(Math.round(x * 1000) / 1000);

  // ====== Mulai gambar ======
  drawHeader();
  const { col, nameWidth } = drawTableHeader();
  doc.font("Helvetica").fontSize(9);

  for (const r of input.rows) {
    // hitung tinggi baris berdasarkan kemungkinan teks panjang di kolom name
    const nameHeight = doc.heightOfString(r.name ?? "", { width: nameWidth });
    const rowHeight = Math.max(16, nameHeight) + 6; // 6 spasi + garis

    ensurePage(rowHeight);

    const y = doc.y;
    doc.text(r.sku ?? "", col.sku, y);
    doc.text(r.name ?? "", col.name, y, { width: nameWidth });
    doc.text(r.baseUom ?? "", col.baseUom, y);
    doc.text(num(r.qtyGudang), col.colA, y, { width: 80, align: "right" });
    doc.text(num(r.qtyEtalase), col.colB, y, { width: 80, align: "right" });
    doc.text(num(r.qtyTotal), col.total, y, { width: 60, align: "right" });

    const lineY = y + Math.max(16, nameHeight);
    doc
      .moveTo(LEFT, lineY)
      .lineTo(RIGHT, lineY)
      .dash(1, { space: 2 })
      .stroke()
      .undash();
    doc.y = lineY + 6;
  }

  // Footer sekali (akhir dokumen)
  drawFooter();
  return makeBuffer(doc);
}

/** =======================
 *  STOCK MOVEMENTS (A4 LANDSCAPE)
 *  ======================= */
export async function buildStockMovementsPdf(input: {
  storeName: string;
  periodLabel: string;
  storeLogoBuffer?: Buffer;
  storeFooterNote?: string;
  rows: Array<{
    createdAt: Date;
    type: string; // IN/SALE/RETURN/TRANSFER/ADJUSTMENT/REPACK
    refId?: string | null;
    sku?: string | null;
    name?: string | null;
    locationCode?: string | null;
    locationName?: string | null;
    uom: string;
    qty: number;
  }>;
}) {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 30, left: 30, right: 30, bottom: 30 },
  });

  const LEFT = 40;
  const RIGHT = 800;
  const BOTTOM_LIMIT = () => doc.page.height - doc.page.margins.bottom - 20;

  /** Header fix — posisi absolut */
  const drawHeader = () => {
    const topY = doc.page.margins.top;
    const logoW = 60;
    const titleX = LEFT + logoW + 10;
    let headerBottom = topY;

    if (input.storeLogoBuffer) {
      try {
        doc.image(input.storeLogoBuffer, LEFT, topY, { width: logoW });
        headerBottom = Math.max(headerBottom, topY + logoW);
      } catch {}
    }

    doc.fontSize(16).text(input.storeName, titleX, topY);
    doc.fontSize(11).text("Laporan Pergerakan Stok", titleX, topY + 18);
    doc.fontSize(10).text(input.periodLabel, titleX, topY + 34);

    const lineY = Math.max(headerBottom, topY + 60);
    doc.moveTo(LEFT, lineY).lineTo(RIGHT, lineY).stroke();

    // Set posisi awal tabel
    const tableStartY = lineY + 15;
    doc.y = tableStartY;
    return tableStartY;
  };

  /** Footer — hanya sekali */
  const drawFooter = () => {
    const footerText =
      input.storeFooterNote ?? "— dicetak otomatis oleh sistem —";
    const footerY = doc.page.height - doc.page.margins.bottom + 5;
    doc.fontSize(8).text(footerText, LEFT, footerY, {
      width: RIGHT - LEFT,
      align: "center",
    });
  };

  /** Header tabel */
  const drawTableHeader = () => {
    doc.font("Helvetica-Bold").fontSize(9);
    const col = {
      date: LEFT,
      type: LEFT + 120,
      ref: LEFT + 190,
      sku: LEFT + 330,
      name: LEFT + 420,
      loc: LEFT + 530,
      uom: LEFT + 640,
      qty: LEFT + 700,
    };
    const nameWidth = col.loc - 10 - col.name; // agar tidak menabrak kolom lokasi

    const y0 = doc.y;
    doc.text("Tanggal", col.date, y0);
    doc.text("Tipe", col.type, y0);
    doc.text("RefId", col.ref, y0, { width: 120 });
    doc.text("SKU", col.sku, y0);
    doc.text("Nama Barang", col.name, y0, { width: nameWidth });
    doc.text("Lokasi", col.loc, y0, { width: 80 });
    doc.text("UOM", col.uom, y0);
    doc.text("Qty", col.qty, y0, { width: 50, align: "right" });

    const lineY = y0 + 14;
    doc.moveTo(LEFT, lineY).lineTo(RIGHT, lineY).stroke();
    doc.y = lineY + 20;

    return { col, nameWidth };
  };

  /** New page if needed */
  const ensurePage = (rowHeight: number) => {
    if (doc.y + rowHeight > BOTTOM_LIMIT()) {
      doc.addPage({ size: "A4", layout: "landscape" });
      drawHeader();
      drawTableHeader();
      doc.font("Helvetica").fontSize(9);
    }
  };

  // ====== Render ======
  drawHeader();
  const { col, nameWidth } = drawTableHeader();
  doc.font("Helvetica").fontSize(9);

  for (const r of input.rows) {
    const nameHeight = doc.heightOfString(r.name ?? "", { width: nameWidth });
    const rowHeight = Math.max(16, nameHeight) + 6;

    ensurePage(rowHeight);

    const y = doc.y;
    doc.text(dayjs(r.createdAt).format("YYYY-MM-DD HH:mm"), col.date, y);
    doc.text(String(r.type), col.type, y);
    doc.text(r.refId ?? "", col.ref, y, { width: 120 });
    doc.text(r.sku ?? "", col.sku, y);
    doc.text(r.name ?? "", col.name, y, { width: nameWidth });

    const locLabel =
      (r.locationCode ?? "") + (r.locationName ? ` - ${r.locationName}` : "");
    doc.text(locLabel, col.loc, y, { width: 70 });

    doc.text(r.uom, col.uom, y);
    doc.text(String(r.qty), col.qty, y, { width: 50, align: "right" });

    const lineY = y + Math.max(26, nameHeight);
    doc
      .moveTo(LEFT, lineY)
      .lineTo(RIGHT, lineY)
      .dash(1, { space: 2 })
      .stroke()
      .undash();
    doc.y = lineY + 20;
  }

  drawFooter();
  return makeBuffer(doc);
}

export async function buildRepackReportPdf(input: {
  storeName: string;
  periodLabel: string;
  storeLogoBuffer?: Buffer;
  storeFooterNote?: string;
  rows: Array<{
    number: string;
    createdAt: Date;
    createdAtLabel: string;
    userName?: string | null;
    notes?: string | null;
    extraCost?: number | null;
    inputs: Array<{
      sku: string | null;
      name: string;
      uom: string;
      qty: number;
    }>;
    outputs: Array<{
      sku: string | null;
      name: string;
      uom: string;
      qty: number;
    }>;
  }>;
}) {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 30, left: 30, right: 30, bottom: 30 },
  });

  // ====== Util lokal ======
  const makeBuffer = (d: PDFKit.PDFDocument) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      d.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      d.on("end", () => resolve(Buffer.concat(chunks)));
      d.on("error", reject);
      d.end();
    });

  const toIDR = (n: number) =>
    "Rp " +
    Math.trunc(n).toLocaleString("id-ID", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });

  // ====== Layout dinamis berdasarkan ukuran halaman ======
  const LEFT = 40;
  const RIGHT = (doc as any).page.width - (doc as any).page.margins.right - 10; // aman di area konten
  const CONTENT_W = RIGHT - LEFT;
  const BOTTOM_LIMIT = () => doc.page.height - doc.page.margins.bottom - 20;

  // Skema kolom: date(100) | number(120) | user(100) | type(60) | sku(90) | name(auto) | uom(60) | qty(50,R) | notes(140) | cost(80,R)
  const wDate = 100;
  const wNum = 120;
  const wType = 60;
  const wSku = 90;
  const wUom = 60;
  const wQty = 50;
  const wCost = 80;
  const gap = 6;

  // Hitung name width sebagai sisa
  const fixedW = wDate + wNum + wType + wSku + wUom + wQty + wCost + gap * 9;
  const wName = Math.max(140, CONTENT_W - fixedW);

  // Titik X kolom
  const xDate = LEFT;
  const xNum = xDate + wDate + gap;
  const xType = xNum + wNum + gap;
  const xSku = xType + wType + gap;
  const xName = xSku + wSku + gap;
  const xUom = xName + wName + gap;
  const xQty = xUom + wUom + gap;
  const xCost = xQty + wQty + gap;

  // ====== Header / Footer ======
  const drawHeader = () => {
    const topY = doc.page.margins.top;
    let headerBottom = topY;
    const logoW = 60;
    const titleX = LEFT + (input.storeLogoBuffer ? logoW + 10 : 0);

    if (input.storeLogoBuffer) {
      try {
        doc.image(input.storeLogoBuffer, LEFT, topY, { width: logoW });
        headerBottom = Math.max(headerBottom, topY + logoW);
      } catch {}
    }
    doc.fontSize(16).text(input.storeName, titleX, topY);
    doc.fontSize(11).text("Laporan Repack", titleX, topY + 18);
    doc.fontSize(10).text(input.periodLabel, titleX, topY + 34);

    const lineY = Math.max(headerBottom, topY + 60);
    doc.moveTo(LEFT, lineY).lineTo(RIGHT, lineY).stroke();

    doc.y = lineY + 15;
    return doc.y;
  };

  const drawFooter = () => {
    const footerText =
      input.storeFooterNote ?? "— dicetak otomatis oleh sistem —";
    const y = doc.page.height - doc.page.margins.bottom + 5;
    doc
      .fontSize(8)
      .text(footerText, LEFT, y, { width: RIGHT - LEFT, align: "center" });
  };

  const drawTableHeader = () => {
    doc.font("Helvetica-Bold").fontSize(9);
    const y0 = doc.y;

    doc.text("Tanggal", xDate, y0, { width: wDate });
    doc.text("Nomor", xNum, y0, { width: wNum });
    doc.text("Tipe", xType, y0, { width: wType });
    doc.text("SKU", xSku, y0, { width: wSku });
    doc.text("Nama Barang", xName, y0, { width: wName });
    doc.text("UOM", xUom, y0, { width: wUom });
    doc.text("Qty", xQty, y0, { width: wQty, align: "right" });
    doc.text("Biaya", xCost, y0, { width: wCost, align: "right" });

    const lineY = y0 + 14;
    doc.moveTo(LEFT, lineY).lineTo(RIGHT, lineY).stroke();
    doc.y = lineY + 20;

    doc.font("Helvetica").fontSize(9);
  };

  const ensurePage = (rowHeight: number) => {
    if (doc.y + rowHeight > BOTTOM_LIMIT()) {
      doc.addPage({ size: "A4", layout: "landscape" });
      drawHeader();
      drawTableHeader();
    }
  };

  // ====== Render ======
  drawHeader();
  drawTableHeader();

  for (const r of input.rows) {
    // Flatten: gabungkan input + output jadi baris data dengan kolom "Tipe"
    const flatLines: Array<{
      type: "INPUT" | "OUTPUT";
      sku: string | null;
      name: string;
      uom: string;
      qty: number;
    }> = [
      ...r.inputs.map((i) => ({ type: "INPUT" as const, ...i })),
      ...r.outputs.map((o) => ({ type: "OUTPUT" as const, ...o })),
    ];

    // Tulis setiap baris; Catatan & Biaya hanya di baris pertama repack
    let firstLine = true;
    for (const line of flatLines) {
      const costTxt =
        firstLine && r.extraCost && r.extraCost > 0 ? toIDR(r.extraCost) : "";

      // Hitung tinggi baris berdasar kolom teks yang panjang (name & notes)
      const nameH = doc.heightOfString(line.name ?? "", { width: wName });
      const skuH = doc.heightOfString(line.sku ?? "", { width: wSku });
      const rowH = Math.max(18, nameH, skuH) + 6;

      ensurePage(rowH);

      const y = doc.y;
      doc.text(r.createdAtLabel, xDate, y, { width: wDate });
      doc.text(r.number, xNum, y, { width: wNum });
      doc.text(line.type, xType, y, { width: wType });
      doc.text(line.sku ?? "", xSku, y, { width: wSku });
      doc.text(line.name ?? "", xName, y, { width: wName });
      doc.text(line.uom, xUom, y, { width: wUom });
      doc.text(String(line.qty), xQty, y, { width: wQty, align: "right" });
      doc.text(costTxt, xCost, y, { width: wCost, align: "right" });

      const lineY = y + Math.max(22, nameH, skuH);
      doc
        .moveTo(LEFT, lineY)
        .lineTo(RIGHT, lineY)
        .dash(1, { space: 2 })
        .stroke()
        .undash();

      doc.y = lineY + 12;
      firstLine = false;
    }
  }

  drawFooter();
  return makeBuffer(doc);
}

/** ======================================================
 *  ADJUSTMENT REPORT (A4 Landscape)
 * ====================================================== */
export async function buildAdjustmentsReportPdf(input: {
  storeName: string;
  periodLabel: string;
  storeLogoBuffer?: Buffer;
  storeFooterNote?: string;
  rows: Array<{
    date: string;
    refId: string | null;
    sku: string;
    name: string;
    location: string;
    uom: string;
    qty: number;
  }>;
}) {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margins: { top: 30, left: 30, right: 30, bottom: 30 },
  });

  const PAGE_W = doc.page.width;
  const PAGE_H = doc.page.height;
  const MARGIN_L = 30;
  const MARGIN_R = 30;
  let y = 30;

  const makeBuffer = (d: PDFKit.PDFDocument) =>
    new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      d.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      d.on("end", () => resolve(Buffer.concat(chunks)));
      d.on("error", reject);
      d.end();
    });

  const drawHeader = () => {
    const topY = y;
    const logoW = 50;
    let xText = MARGIN_L;

    if (input.storeLogoBuffer) {
      try {
        doc.image(input.storeLogoBuffer, MARGIN_L, topY, { width: logoW });
        xText = MARGIN_L + logoW + 10;
      } catch {
        xText = MARGIN_L;
      }
    }

    doc.fontSize(14).text(input.storeName, xText, topY, {
      width: PAGE_W - MARGIN_R - xText,
    });
    doc.fontSize(10).text("Laporan Penyesuaian Stok", xText, doc.y + 2);
    doc.fontSize(9).text(`Periode: ${input.periodLabel}`, xText, doc.y + 2);

    y = Math.max(topY + 60, doc.y + 10);
    doc
      .moveTo(MARGIN_L, y)
      .lineTo(PAGE_W - MARGIN_R, y)
      .stroke();
    y += 8;
  };

  drawHeader();

  const colW = {
    date: 70,
    ref: 80,
    sku: 70,
    name: 230,
    location: 160,
    uom: 40,
    qty: 60,
  };
  const colX = {
    date: MARGIN_L,
    ref: MARGIN_L + colW.date,
    sku: MARGIN_L + colW.date + colW.ref,
    name: MARGIN_L + colW.date + colW.ref + colW.sku,
    location: MARGIN_L + colW.date + colW.ref + colW.sku + colW.name,
    uom: MARGIN_L + colW.date + colW.ref + colW.sku + colW.name + colW.location,
    qty:
      MARGIN_L +
      colW.date +
      colW.ref +
      colW.sku +
      colW.name +
      colW.location +
      colW.uom,
  };

  function ensureSpace(h: number) {
    const safeBottom = doc.page.height - 40;
    if (y + h > safeBottom) {
      doc.addPage();
      y = 30;
      drawHeader();
      drawTableHeader();
    }
  }

  function drawTableHeader() {
    doc.font("Helvetica-Bold").fontSize(9);
    doc.text("Tanggal", colX.date, y, { width: colW.date });
    doc.text("Ref", colX.ref, y, { width: colW.ref });
    doc.text("SKU", colX.sku, y, { width: colW.sku });
    doc.text("Nama Barang", colX.name, y, { width: colW.name });
    doc.text("Lokasi", colX.location, y, { width: colW.location });
    doc.text("UOM", colX.uom, y, { width: colW.uom, align: "center" });
    doc.text("Qty", colX.qty, y, { width: colW.qty, align: "right" });

    y += 14;
    doc
      .moveTo(MARGIN_L, y)
      .lineTo(PAGE_W - MARGIN_R, y)
      .stroke();
    y += 4;
    doc.font("Helvetica").fontSize(9);
  }

  drawTableHeader();

  input.rows.forEach((r) => {
    ensureSpace(22);
    const hName = doc.heightOfString(r.name ?? "", { width: colW.name });
    const hLoc = doc.heightOfString(r.location ?? "", { width: colW.location });
    const rowH = Math.max(14, hName, hLoc) + 2;
    const baseY = y;

    doc.text(r.date, colX.date, baseY, { width: colW.date });
    doc.text(r.refId ?? "", colX.ref, baseY, { width: colW.ref });
    doc.text(r.sku ?? "", colX.sku, baseY, { width: colW.sku });
    doc.text(r.name ?? "", colX.name, baseY, { width: colW.name });
    doc.text(r.location ?? "", colX.location, baseY, { width: colW.location });
    doc.text(r.uom ?? "", colX.uom, baseY, {
      width: colW.uom,
      align: "center",
    });
    doc.text(String(r.qty ?? 0), colX.qty, baseY, {
      width: colW.qty,
      align: "right",
    });

    y += rowH;
    doc
      .moveTo(MARGIN_L, y)
      .lineTo(PAGE_W - MARGIN_R, y)
      .dash(1, { space: 2 })
      .stroke()
      .undash();
    y += 2;
  });

  y += 8;
  const footer = input.storeFooterNote ?? "— dicetak otomatis oleh sistem —";
  doc.fontSize(8).text(footer, MARGIN_L, y, {
    width: PAGE_W - MARGIN_L - MARGIN_R,
    align: "center",
  });

  return makeBuffer(doc);
}

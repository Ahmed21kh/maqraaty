// Builds the downloadable files (Excel / PDF / Word) and reads uploaded Excel sheets.
//
//   buildXlsx(spec)  → Buffer   real .xlsx, RTL sheet, styled header, filters, frozen header, auto widths
//   buildPdf(spec)   → Buffer   A4 PDF, right-to-left table with Arabic shaping, repeated header, page numbers
//   buildDoc(spec)   → Buffer   Word-compatible document (HTML with Word page setup), right-to-left table
//   readXlsx(buffer) → string[][]
//   studentsTemplate() → Buffer  the empty import sheet with an example row
//
// spec = { title, subtitle?, columns: [{ header, width? }], rows: (string|number|null)[][], color? }

const path = require("path");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");

const THEME_FALLBACK = "#1f6f5c";
const FONT_DIR = path.join(__dirname, "..", "node_modules", "@fontsource", "cairo", "files");
const FONTS = {
  arabic: path.join(FONT_DIR, "cairo-arabic-400-normal.woff"),
  arabicBold: path.join(FONT_DIR, "cairo-arabic-700-normal.woff"),
  latin: path.join(FONT_DIR, "cairo-latin-400-normal.woff"),
  latinBold: path.join(FONT_DIR, "cairo-latin-700-normal.woff"),
};

const text = (v) => (v === null || v === undefined ? "" : String(v).trim());
const escapeHtml = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const stamp = () => new Date().toLocaleString("ar-EG-u-nu-latn", { dateStyle: "full", timeStyle: "short" });
const themeOf = (spec) => (/^#[0-9a-f]{6}$/i.test(spec.color || "") ? spec.color : THEME_FALLBACK);
const metaLine = (spec) => [spec.subtitle, `${spec.rows.length} سجل`, stamp()].filter(Boolean).join("   •   ");

// ───────────────────────────────────────────────────────────────── Excel

async function buildXlsx(spec) {
  const theme = themeOf(spec).replace("#", "").toUpperCase();
  const wb = new ExcelJS.Workbook();
  wb.creator = "مقرأتي";
  wb.created = new Date();
  const ws = wb.addWorksheet(String(spec.title).replace(/[\\/?*[\]:]/g, " ").slice(0, 31), {
    views: [{ rightToLeft: true, state: "frozen", ySplit: 3 }],
    pageSetup: { orientation: spec.columns.length > 6 ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
  });
  const lastCol = spec.columns.length + 1; // + the "#" column
  const thin = (argb) => ({ style: "thin", color: { argb } });
  const border = (argb) => ({ top: thin(argb), left: thin(argb), bottom: thin(argb), right: thin(argb) });

  ws.mergeCells(1, 1, 1, lastCol);
  const title = ws.getCell(1, 1);
  title.value = spec.title;
  title.font = { name: "Cairo", size: 16, bold: true, color: { argb: "FF" + theme } };
  title.alignment = { horizontal: "right", vertical: "middle" };
  ws.getRow(1).height = 30;
  ws.mergeCells(2, 1, 2, lastCol);
  const sub = ws.getCell(2, 1);
  sub.value = metaLine(spec);
  sub.font = { name: "Cairo", size: 10, color: { argb: "FF6B7280" } };
  sub.alignment = { horizontal: "right" };

  const header = ws.getRow(3);
  ["#", ...spec.columns.map((c) => c.header)].forEach((h, i) => {
    const cell = header.getCell(i + 1);
    cell.value = h;
    cell.font = { name: "Cairo", bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + theme } };
    cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    cell.border = border("FFFFFFFF");
  });
  header.height = 24;

  spec.rows.forEach((values, r) => {
    const row = ws.getRow(4 + r);
    [r + 1, ...values].forEach((v, i) => {
      const cell = row.getCell(i + 1);
      cell.value = v === "" ? null : v;
      cell.font = { name: "Cairo", size: 11 };
      cell.alignment = { horizontal: typeof v === "number" || i === 0 ? "center" : "right", vertical: "middle", wrapText: true };
      cell.border = border("FFE5E7EB");
      if (r % 2 === 1) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF3F4F6" } };
    });
  });

  ws.getColumn(1).width = 6;
  spec.columns.forEach((c, i) => {
    const longest = spec.rows.reduce((m, row) => Math.max(m, text(row[i]).length), c.header.length);
    ws.getColumn(i + 2).width = c.width || Math.min(48, Math.max(10, longest + 3));
  });
  ws.autoFilter = { from: { row: 3, column: 1 }, to: { row: 3, column: lastCol } };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** First sheet as text rows; empty cells are ''. */
async function readXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) return [];
  const cellValue = (v) => {
    if (v === null || v === undefined) return "";
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (typeof v === "object") {
      if (v.richText) return v.richText.map((t) => t.text).join("").trim();
      if (v.result !== undefined) return cellValue(v.result);
      if (v.text !== undefined) return cellValue(v.text);
      return "";
    }
    return String(v).trim();
  };
  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values; // 1-based
    rows.push(Array.from({ length: Math.max(0, values.length - 1) }, (_, i) => cellValue(values[i + 1])));
  });
  return rows.filter((r) => r.some((c) => c !== ""));
}

// ──────────────────────────────────────────────────────────── Word / HTML

function htmlDocument(spec, word) {
  const color = themeOf(spec);
  const landscape = spec.columns.length > 6;
  const head = ["#", ...spec.columns.map((c) => c.header)].map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const body = spec.rows
    .map((values, r) => `<tr class="${r % 2 ? "alt" : ""}"><td class="n">${r + 1}</td>${values.map((v) => `<td>${escapeHtml(text(v)) || "—"}</td>`).join("")}</tr>`)
    .join("");
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="utf-8">
<title>${escapeHtml(spec.title)}</title>
<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View><w:Zoom>100</w:Zoom><w:DoNotOptimizeForBrowser/></w:WordDocument></xml><![endif]-->
<style>
  @page WordSection1 { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 14mm 12mm; mso-page-orientation: ${landscape ? "landscape" : "portrait"}; }
  div.WordSection1 { page: WordSection1; }
  body { margin: 0; font-family: 'Cairo', 'Segoe UI', Tahoma, Arial, sans-serif; color: #111827; direction: rtl; }
  h1 { margin: 0 0 4px; font-size: 20px; color: ${color}; }
  .meta { margin: 0 0 14px; font-size: 11px; color: #6b7280; }
  table { width: 100%; border-collapse: collapse; direction: rtl; font-size: ${spec.columns.length > 8 ? 10 : 11.5}px; }
  th { padding: 7px 8px; color: #fff; background: ${color}; border: 1px solid ${color}; text-align: center; font-weight: 700; }
  td { padding: 6px 8px; border: 1px solid #e5e7eb; text-align: right; vertical-align: middle; }
  td.n { width: 28px; text-align: center; color: #6b7280; }
  tr.alt td { background: #f3f4f6; }
</style>
</head>
<body>
<div class="WordSection1" dir="rtl">
  <h1>${escapeHtml(spec.title)}</h1>
  <p class="meta">${escapeHtml(metaLine(spec))}</p>
  <table dir="rtl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</div>
</body>
</html>`;
}

function buildDoc(spec) {
  return Buffer.from("﻿" + htmlDocument(spec, true), "utf8");
}

// ───────────────────────────────────────────────────────────────── PDF
//
// PDFKit shapes Arabic letters (joining forms) but lays text out left-to-right, so the layout is done here:
// a cell's words are placed from the right edge, and each word is split into Arabic runs (Cairo Arabic) and
// everything else (digits, Latin, punctuation: Cairo Latin) so numbers keep their reading order.

const ARABIC = /[؀-ۿݐ-ݿࢠ-ࣿﭐ-﷿ﹰ-﻿]/;

function runsOf(word) {
  const runs = [];
  for (const ch of word) {
    const ar = ARABIC.test(ch);
    const last = runs[runs.length - 1];
    if (last && last.ar === ar) last.t += ch;
    else runs.push({ ar, t: ch });
  }
  return runs;
}

function buildPdf(spec) {
  return new Promise((resolve, reject) => {
    const color = themeOf(spec);
    const landscape = spec.columns.length > 6;
    const doc = new PDFDocument({ size: "A4", layout: landscape ? "landscape" : "portrait", margin: 28, bufferPages: true, info: { Title: spec.title, Author: "مقرأتي" } });
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    Object.entries(FONTS).forEach(([name, file]) => doc.registerFont(name, file));

    const fontSize = spec.columns.length > 8 ? 8.5 : 10;
    const pad = 4;
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 14;
    const usable = right - left;

    const setFont = (run, bold) => doc.font(run.ar ? (bold ? "arabicBold" : "arabic") : bold ? "latinBold" : "latin").fontSize(run.size || fontSize);
    const wordWidth = (word, bold, size) => runsOf(word).reduce((w, run) => w + setFont({ ...run, size }, bold).widthOfString(run.t), 0);
    const spaceWidth = (bold, size) => setFont({ ar: false, size }, bold).widthOfString(" ");

    /** Greedy word wrap from the right edge: returns lines of words (logical order), width in points. */
    function wrap(str, maxWidth, bold, size) {
      const words = text(str).split(/\s+/).filter(Boolean);
      if (!words.length) return [[]];
      const space = spaceWidth(bold, size);
      const lines = [[]];
      let used = 0;
      for (const w of words) {
        const ww = wordWidth(w, bold, size);
        if (lines[lines.length - 1].length && used + space + ww > maxWidth) {
          lines.push([]);
          used = 0;
        }
        const line = lines[lines.length - 1];
        used += (line.length ? space : 0) + ww;
        line.push(w);
      }
      return lines;
    }

    /** Draws wrapped lines inside a cell, right-aligned (or centred). */
    function drawLines(lines, x, y, width, { bold = false, size = fontSize, fill = "#111827", align = "right" } = {}) {
      const lineHeight = size * 1.5;
      const space = spaceWidth(bold, size);
      lines.forEach((words, li) => {
        const total = words.reduce((w, word, i) => w + wordWidth(word, bold, size) + (i ? space : 0), 0);
        let cursor = align === "center" ? x + (width + total) / 2 : x + width;
        words.forEach((word) => {
          runsOf(word).forEach((run) => {
            const rw = setFont({ ...run, size }, bold).widthOfString(run.t);
            cursor -= rw;
            doc.fillColor(fill).text(run.t, cursor, y + li * lineHeight, { lineBreak: false });
          });
          cursor -= space;
        });
      });
    }

    // column widths (right to left): "#" + data columns, proportional to their content, then scaled to the page
    const headers = ["#", ...spec.columns.map((c) => c.header)];
    const matrix = spec.rows.map((r, i) => [i + 1, ...r].map(text));
    const measure = headers.map((h, i) => {
      const sample = matrix.slice(0, 400).reduce((m, r) => Math.max(m, wordWidth(r[i] || "", false, fontSize)), 0);
      const hw = wordWidth(h, true, fontSize);
      return i === 0 ? Math.max(24, sample + pad * 2) : Math.min(Math.max(hw, sample) + pad * 2 + 6, usable * 0.34);
    });
    const scale = usable / measure.reduce((a, b) => a + b, 0);
    const widths = measure.map((w) => w * scale);

    let y;
    const drawTitle = () => {
      doc.rect(right - 4, doc.page.margins.top, 4, 30).fill(color);
      drawLines([[spec.title]], left, doc.page.margins.top, usable - 12, { bold: true, size: 17, fill: color });
      drawLines(wrap(metaLine(spec), usable, false, 8.5), left, doc.page.margins.top + 24, usable - 12, { size: 8.5, fill: "#6b7280" });
      y = doc.page.margins.top + 46;
    };
    const drawHeader = () => {
      const h = fontSize * 1.5 + pad * 2 + 2;
      doc.rect(left, y, usable, h).fill(color);
      let x = right;
      headers.forEach((head, i) => {
        x -= widths[i];
        drawLines([[head]], x + pad, y + pad + 1, widths[i] - pad * 2, { bold: true, fill: "#ffffff", align: "center" });
      });
      y += h;
    };

    drawTitle();
    drawHeader();
    matrix.forEach((cells, r) => {
      const wrapped = cells.map((c, i) => wrap(c, widths[i] - pad * 2, false, fontSize));
      const rowHeight = Math.max(...wrapped.map((l) => l.length)) * fontSize * 1.5 + pad * 2;
      if (y + rowHeight > bottom()) {
        doc.addPage();
        y = doc.page.margins.top;
        drawHeader();
      }
      if (r % 2) doc.rect(left, y, usable, rowHeight).fill("#f3f4f6");
      let x = right;
      wrapped.forEach((lines, i) => {
        x -= widths[i];
        const cellText = cells[i] === "" ? [["—"]] : lines;
        drawLines(cellText, x + pad, y + pad, widths[i] - pad * 2, { align: i === 0 ? "center" : "right", fill: i === 0 ? "#6b7280" : "#111827" });
      });
      doc.lineWidth(0.4).strokeColor("#e5e7eb").moveTo(left, y + rowHeight).lineTo(right, y + rowHeight).stroke();
      y += rowHeight;
    });

    // page numbers
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      doc.font("latin").fontSize(8).fillColor("#6b7280").text(`${i + 1} / ${range.count}`, left, doc.page.height - doc.page.margins.bottom + 2, { width: usable, align: "center", lineBreak: false });
    }
    doc.end();
  });
}

// ──────────────────────────────────────────────────────────── import sheet

/** Headers of the student import sheet and the field each one fills. */
const STUDENT_COLUMNS = [
  { header: "الاسم", field: "name", example: "احمد محمد علي", required: true },
  { header: "موبايل الطالب", field: "phone_1", example: "01012345678" },
  { header: "موبايل الام", field: "phone_2", example: "" },
  { header: "موبايل الاب", field: "phone_3", example: "" },
  { header: "التليفون الارضي", field: "landline", example: "" },
  { header: "السن", field: "age", example: 12 },
  { header: "السنة الدراسية", field: "study_year", example: "الصف الخامس" },
  { header: "العنوان", field: "address", example: "شارع المدرسة" },
  { header: "المصروفات", field: "amount", example: 150 },
  { header: "تاريخ التسجيل", field: "date", example: "2026-10-01" },
  { header: "ازهري (نعم/لا)", field: "is_Azhar", example: "لا" },
  { header: "معفى من المصروفات (نعم/لا)", field: "is_payment", example: "لا" },
  { header: "الملاحظات", field: "notes", example: "" },
  // the stored photo path, exactly as exported; leave it empty for new students
  { header: "الصورة", field: "image", example: "" },
];

async function studentsTemplate() {
  return buildXlsx({
    title: "نموذج استيراد الطلاب",
    subtitle: "املأ البيانات تحت العناوين — الاسم مطلوب والموبايل 11 رقم — عمود الصورة اتركه فارغا للطلاب الجدد",
    columns: STUDENT_COLUMNS.map((c) => ({ header: c.header, width: c.header.length + 8 })),
    rows: [STUDENT_COLUMNS.map((c) => c.example)],
  });
}

module.exports = { buildXlsx, buildPdf, buildDoc, readXlsx, studentsTemplate, STUDENT_COLUMNS };

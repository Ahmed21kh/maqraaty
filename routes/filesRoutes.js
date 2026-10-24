// Export / import endpoints (mounted under /api):
//
//   POST /export                       { format: 'xlsx'|'pdf'|'doc', title, subtitle?, fileName?, color?, columns: [{header}], rows: [[…]] }
//                                      → the generated file as a download
//   GET  /import_students/template     → the empty Excel sheet to fill in
//   POST /import_students/file         multipart `file` (.xlsx); `?dryRun=1` only checks it
//                                      → { total, valid, invalid:[{row,reason}], preview:[…] }            (dry run)
//                                      → { created:[{_id,code,name}], skipped:[{row,reason}] }            (import)

const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const { buildXlsx, buildPdf, buildDoc, readXlsx, studentsTemplate, STUDENT_COLUMNS } = require("../services/files.service");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const FORMATS = {
  xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", build: buildXlsx },
  pdf: { type: "application/pdf", build: buildPdf },
  doc: { type: "application/msword", build: buildDoc },
};

const send = (res, buffer, type, fileName) => {
  // RFC 5987 so Arabic file names survive; the plain name is an ASCII fallback
  res.set({
    "Content-Type": type,
    "Content-Disposition": `attachment; filename="export"; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "Access-Control-Expose-Headers": "Content-Disposition",
    "Content-Length": buffer.length,
  });
  res.status(200).send(buffer);
};

// ─────────────────────────────────────────────────────────────── export

router.post("/export", express.json({ limit: "20mb" }), async (req, res) => {
  try {
    const { format = "xlsx", title = "تقرير", subtitle = "", fileName, color, columns, rows } = req.body || {};
    const target = FORMATS[format];
    if (!target) return res.status(400).json({ message: "format must be xlsx, pdf or doc" });
    if (!Array.isArray(columns) || !columns.length || !Array.isArray(rows)) {
      return res.status(400).json({ message: "columns and rows are required" });
    }
    if (rows.length > 20000) return res.status(400).json({ message: "at most 20000 rows per export" });

    const spec = {
      title: String(title).slice(0, 120),
      subtitle: String(subtitle).slice(0, 300),
      color,
      columns: columns.map((c) => ({ header: String(c.header ?? ""), width: Number(c.width) || undefined })),
      rows: rows.map((r) => (Array.isArray(r) ? r : []).slice(0, columns.length)),
    };
    const buffer = await target.build(spec);
    const safeName = String(fileName || title).replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 80) || "export";
    send(res, buffer, target.type, `${safeName}.${format}`);
  } catch (e) {
    console.error("export failed:", e);
    res.status(500).json({ message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────── import

router.get("/import_students/template", async (req, res) => {
  try {
    send(res, await studentsTemplate(), FORMATS.xlsx.type, "نموذج استيراد الطلاب.xlsx");
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

const norm = (v) => String(v ?? "").replace(/[ً-ٟـ]/g, "").replace(/\s+/g, " ").trim();

/** Phone cells often lose their leading zero in Excel (1012345678 instead of 01012345678). */
const phoneOf = (v) => {
  const digits = String(v ?? "").replace(/[^\d]/g, "");
  return digits.length === 10 && digits.startsWith("1") ? "0" + digits : digits;
};

/**
 * Registration dates come in as they were exported (25-10-2026), typed by hand (25/10/2026), as ISO (2026-10-25)
 * or as an Excel date serial. Day-first is assumed for the dotted/dashed/slashed forms. Returns null when unreadable.
 */
function parseDate(value) {
  const v = String(value ?? "").trim();
  if (!v) return null;
  let y, m, d;
  let match;
  if ((match = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) [, y, m, d] = match;
  else if ((match = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/))) [, d, m, y] = match;
  else if (/^\d{5}(\.\d+)?$/.test(v)) return new Date(Math.round((Number(v) - 25569) * 86400000)); // Excel serial
  else return null;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), 12));
  return date.getUTCMonth() === Number(m) - 1 && date.getUTCDate() === Number(d) ? date : null;
}

const yesNo = (v) => (/^(نعم|yes|y|1|true)$/i.test(norm(v)) ? "نعم" : "لا");

/** Finds the header row (it may follow the title rows of our own template) and maps columns to fields. */
function mapSheet(sheet) {
  const base = (h) => norm(h).split(" (")[0]; // "ازهري (نعم/لا)" matches "ازهري"
  let headerIndex = sheet.findIndex((row) => row.some((cell) => base(cell) === "الاسم"));
  if (headerIndex < 0) headerIndex = 0;
  const header = sheet[headerIndex].map(base);
  const cols = {};
  STUDENT_COLUMNS.forEach((c) => {
    const i = header.indexOf(base(c.header));
    if (i >= 0) cols[c.field] = i;
  });
  if (cols.name === undefined) return { error: 'لم يتم العثور على عمود "الاسم" في الملف' };
  const items = sheet.slice(headerIndex + 1).map((cells, i) => {
    const get = (f) => (cols[f] === undefined ? "" : cells[cols[f]] ?? "");
    return {
      row: headerIndex + 2 + i, // the row number as Excel shows it
      name: norm(get("name")),
      phone_1: phoneOf(get("phone_1")),
      phone_2: phoneOf(get("phone_2")),
      phone_3: phoneOf(get("phone_3")),
      landline: String(get("landline")).trim(),
      age: Number(get("age")),
      study_year: norm(get("study_year")),
      address: norm(get("address")),
      amount: Number(get("amount")),
      date: parseDate(get("date")), // null → today (an unreadable date never blocks the student)
      is_Azhar: yesNo(get("is_Azhar")),
      is_payment: yesNo(get("is_payment")),
      notes: norm(get("notes")),
      image: String(get("image")).trim(), // kept verbatim: it is the stored photo path
    };
  });
  // a row with nothing recognisable is just trailing formatting
  return { items: items.filter((it) => it.name || it.phone_1 || it.phone_2 || it.phone_3) };
}

function check(item) {
  if (item.name.length < 2) return "الاسم مطلوب";
  if ([item.phone_1, item.phone_2, item.phone_3].some((p) => p && !/^\d{11}$/.test(p))) return "رقم الموبايل يجب ان يكون 11 رقم";
  return null;
}

router.post("/import_students/file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "ارفق ملف Excel" });
    let sheet;
    try {
      sheet = await readXlsx(req.file.buffer);
    } catch {
      return res.status(400).json({ message: "تعذر قراءة الملف — تأكد انه ملف Excel بصيغة xlsx" });
    }
    if (sheet.length < 2) return res.status(400).json({ message: "الملف فارغ" });
    const mapped = mapSheet(sheet);
    if (mapped.error) return res.status(400).json({ message: mapped.error });
    if (mapped.items.length > 2000) return res.status(400).json({ message: "الحد الاقصى 2000 طالب في المرة الواحدة" });

    const Student = mongoose.model("student");
    const existing = await Student.find({}, { name: 1, phone_1: 1, code: 1 }).lean();
    const key = (name, phone) => `${norm(name)}|${phone || ""}`;
    const seen = new Set(existing.map((s) => key(s.name || "", (s.phone_1 || [])[0])));

    const valid = [];
    const invalid = [];
    for (const item of mapped.items) {
      const problem = check(item) || (seen.has(key(item.name, item.phone_1)) ? "الطالب موجود بالفعل" : null);
      if (problem) {
        invalid.push({ row: item.row, name: item.name, reason: problem });
        continue;
      }
      seen.add(key(item.name, item.phone_1)); // also catches duplicates inside the file
      valid.push(item);
    }

    if (req.query.dryRun === "1") {
      return res.status(200).json({
        total: mapped.items.length,
        valid: valid.length,
        invalid,
        preview: valid.slice(0, 8).map((v) => ({ row: v.row, name: v.name, phone_1: v.phone_1, age: v.age || "", study_year: v.study_year, amount: v.amount || "" })),
      });
    }

    let nextCode = existing.reduce((m, s) => Math.max(m, Number(s.code) || 0), 0) + 1;
    const created = [];
    for (const item of valid) {
      const date = item.date || new Date();
      const doc = await Student.create({
        active_status: "active",
        code: nextCode++,
        name: item.name,
        phone_1: [item.phone_1 || ""],
        phone_2: [item.phone_2 || ""],
        phone_3: [item.phone_3 || ""],
        landline: item.landline,
        age: Number.isFinite(item.age) && item.age > 0 ? item.age : undefined,
        study_year: item.study_year,
        address: item.address,
        notes: item.notes,
        amount: Number.isFinite(item.amount) && item.amount > 0 ? item.amount : undefined,
        date,
        is_Azhar: item.is_Azhar,
        is_payment: item.is_payment,
        has_relative: "لا",
        relative: [],
        image: item.image || "",
      });
      created.push({ _id: doc._id, code: doc.code, name: doc.name });
    }
    res.status(200).json({ created, skipped: invalid });
  } catch (e) {
    console.error("import failed:", e);
    res.status(500).json({ message: e.message });
  }
});

module.exports = router;

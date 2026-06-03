import ExcelJS from "exceljs";
import { getDb } from "./db";

interface ExportOpts {
  from?: string;
  to?: string;
  accounts?: string[];
  includeTopsheet: boolean;
  includeTransactions: boolean;
}

export async function generateExport(opts: ExportOpts): Promise<Buffer> {
  const db = getDb();

  let whereClauses = ["1=1"];
  const params: unknown[] = [];
  if (opts.from) { whereClauses.push("t.date >= ?"); params.push(opts.from); }
  if (opts.to) { whereClauses.push("t.date <= ?"); params.push(opts.to); }
  if (opts.accounts && opts.accounts.length > 0) {
    whereClauses.push(`t.account_id IN (${opts.accounts.map(() => "?").join(",")})`);
    params.push(...opts.accounts);
  }
  const where = whereClauses.join(" AND ");

  const rows = db.query(`
    SELECT t.date, t.vendor, t.description, t.amount, t.account_id, t.account_label,
      t.line_code, COALESCE(lc.label, '') as line_label, COALESCE(lc.category, '') as category,
      t.source, t.coded_by
    FROM transactions t
    LEFT JOIN line_codes lc ON t.line_code = lc.code
    WHERE ${where}
    ORDER BY t.date DESC, t.created_at DESC
  `).all(...params) as Array<Record<string, unknown>>;

  const lineCodes = db.query(
    "SELECT code, category, category_code, label FROM line_codes ORDER BY category_code, code"
  ).all() as Array<{ code: string; category: string; category_code: number; label: string }>;

  // Group by category to prevent splits from bad category_code data
  const orderedByCategory: typeof lineCodes = [];
  const catSeen = new Set<string>();
  const catGroups = new Map<string, typeof lineCodes>();
  for (const lc of lineCodes) {
    if (!catGroups.has(lc.category)) catGroups.set(lc.category, []);
    catGroups.get(lc.category)!.push(lc);
  }
  for (const lc of lineCodes) {
    if (!catSeen.has(lc.category)) {
      catSeen.add(lc.category);
      orderedByCategory.push(...catGroups.get(lc.category)!);
    }
  }

  const byAccount = new Map<string, Array<Record<string, unknown>>>();
  for (const r of rows) {
    const key = (r.account_label as string) || (r.account_id as string) || "Unknown";
    if (!byAccount.has(key)) byAccount.set(key, []);
    byAccount.get(key)!.push(r);
  }

  const wb = new ExcelJS.Workbook();
  const txnCols = ["date", "vendor", "description", "amount", "line_code", "line_label", "category", "source", "coded_by"];
  const txnHeaders = ["Date", "Vendor", "Description", "Amount", "Line Code", "Line Name", "Category", "Source", "Coded By"];

  // Pre-compute sheet names for SUMIF references (dedup to avoid ExcelJS crash)
  const txnSheetNames: string[] = [];
  if (opts.includeTransactions) {
    const seen = new Map<string, number>();
    for (const [label] of byAccount) {
      let name = label.replace(/[\\/*?[\]:]/g, "_").slice(0, 31);
      const prev = seen.get(name) || 0;
      seen.set(name, prev + 1);
      if (prev > 0) name = name.slice(0, 27) + ` (${prev})`;
      txnSheetNames.push(name);
    }
  }

  // Topsheet first so it's the first tab
  if (opts.includeTopsheet) {
    const ws = wb.addWorksheet("Topsheet", { properties: { tabColor: { argb: "FF1A1814" } } });

    ws.getColumn(1).width = 8;
    ws.getColumn(2).width = 8;
    ws.getColumn(3).width = 30;
    ws.getColumn(4).width = 14;
    ws.getColumn(4).numFmt = '#,##0.00';
    ws.getColumn(5).width = 14;
    ws.getColumn(5).numFmt = '#,##0.00';

    let currentCategory = "";
    let catStartRow = 0;

    for (const lc of orderedByCategory) {
      if (lc.category !== currentCategory) {
        if (currentCategory && catStartRow > 0) {
          const sumRow = ws.addRow(["", "", "", null,
            { formula: `SUM(D${catStartRow}:D${ws.rowCount})` }
          ]);
          sumRow.getCell(5).font = { bold: true, size: 11 };
          ws.addRow([]);
        }

        currentCategory = lc.category;
        const catRow = ws.addRow([lc.category_code, lc.category]);
        catRow.font = { bold: true, size: 11 };
        catStartRow = ws.rowCount + 1;
      }

      if (txnSheetNames.length > 0) {
        const sumifParts = txnSheetNames.map(name => {
          const safe = `'${name.replace(/'/g, "''")}'`;
          return `SUMIF(${safe}!$E:$E,B${ws.rowCount + 1},${safe}!$D:$D)`;
        });
        const formula = sumifParts.join("+");
        ws.addRow(["", lc.code, lc.label, { formula }]);
      } else {
        const matching = rows.filter(r => r.line_code === lc.code);
        const total = matching.reduce((s, r) => s + (Number(r.amount) || 0), 0);
        ws.addRow(["", lc.code, lc.label, matching.length > 0 ? total : ""]);
      }
    }

    if (currentCategory && catStartRow > 0) {
      const sumRow = ws.addRow(["", "", "", null,
        { formula: `SUM(D${catStartRow}:D${ws.rowCount})` }
      ]);
      sumRow.getCell(5).font = { bold: true, size: 11 };
    }
  }

  // Transaction sheets after topsheet
  if (opts.includeTransactions) {
    let i = 0;
    for (const [, txns] of byAccount) {
      const ws = wb.addWorksheet(txnSheetNames[i++]);

      const headerRow = ws.addRow(txnHeaders);
      headerRow.font = { bold: true, size: 10 };
      headerRow.alignment = { horizontal: "left" };

      ws.getColumn(1).width = 12;
      ws.getColumn(2).width = 28;
      ws.getColumn(3).width = 36;
      ws.getColumn(4).width = 12;
      ws.getColumn(4).numFmt = '#,##0.00';
      ws.getColumn(5).width = 10;
      ws.getColumn(6).width = 24;
      ws.getColumn(7).width = 18;
      ws.getColumn(8).width = 8;
      ws.getColumn(9).width = 8;

      for (const t of txns) {
        ws.addRow(txnCols.map(k => {
          const v = t[k];
          if (k === "amount") return Number(v) || 0;
          if (k === "date" && typeof v === "string") return v;
          return v ?? "";
        }));
      }
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

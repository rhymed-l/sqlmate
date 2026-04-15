import JSZip from "jszip";

export interface TableData {
  tableName: string;
  columns: string[];
  rows: string[][];
}

function normalizeTableName(raw: string): string {
  const stripped = raw.replace(/`/g, "");
  const parts = stripped.split(".");
  return parts[parts.length - 1] ?? "";
}

function parseColumns(colStr: string): string[] {
  return colStr
    .slice(1, -1) // remove surrounding parens
    .split(",")
    .map((c) => c.trim().replace(/`/g, ""));
}

/** Parse a single SQL value token to a plain string. */
function parseSqlValue(raw: string): string {
  const t = raw.trim();
  if (t.toUpperCase() === "NULL") return "";
  if (t.startsWith("'") && t.endsWith("'") && t.length >= 2) {
    return t.slice(1, -1).replace(/''/g, "'").replace(/\\'/g, "'");
  }
  return t;
}

/** Split a VALUES tuple "(a, 'b', NULL)" into individual token strings. */
function splitTupleTokens(tuple: string): string[] {
  const inner = tuple.startsWith("(") && tuple.endsWith(")")
    ? tuple.slice(1, -1)
    : tuple;
  const tokens: string[] = [];
  let depth = 0;
  let inStr = false;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inStr) {
      if (ch === "\\") { i++; continue; }
      if (ch === "'" && inner[i + 1] === "'") { i++; continue; }
      if (ch === "'") inStr = false;
    } else {
      if (ch === "'") inStr = true;
      else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (ch === "," && depth === 0) {
        tokens.push(inner.slice(start, i).trim());
        start = i + 1;
      }
    }
  }
  tokens.push(inner.slice(start).trim());
  return tokens;
}

const INSERT_HDR_RE =
  /INSERT\s+(?:LOW_PRIORITY\s+|DELAYED\s+|HIGH_PRIORITY\s+|IGNORE\s+)?INTO\s+((?:`[^`]+`|\w+)(?:\.(?:`[^`]+`|\w+))?)\s*(\([^)]*\))?\s*VALUES\s*/i;

function processStatement(stmt: string, tableMap: Map<string, TableData>): void {
  const match = INSERT_HDR_RE.exec(stmt);
  if (!match) return;

  const tableName = normalizeTableName(match[1]);
  const colStr = match[2] ?? "";
  const valuesOffset = match.index + match[0].length;
  const valuesRaw = stmt
    .slice(valuesOffset)
    .replace(/[;\s]+$/, "")
    .trim();

  if (!tableMap.has(tableName)) {
    const columns = colStr ? parseColumns(colStr) : [];
    tableMap.set(tableName, { tableName, columns, rows: [] });
  }
  const td = tableMap.get(tableName)!;

  // Walk valuesRaw to find top-level tuples: (a,b),(c,d),...
  let depth = 0;
  let tupleStart = -1;
  for (let i = 0; i < valuesRaw.length; i++) {
    const ch = valuesRaw[i];
    if (ch === "(") {
      if (depth === 0) tupleStart = i;
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0 && tupleStart !== -1) {
        const tuple = valuesRaw.slice(tupleStart, i + 1);
        const tokens = splitTupleTokens(tuple).map(parseSqlValue);
        // Generate column names from first tuple if INSERT had no column list
        if (td.columns.length === 0 && td.rows.length === 0) {
          td.columns = tokens.map((_, idx) => `col${idx + 1}`);
        }
        td.rows.push(tokens);
        tupleStart = -1;
      }
    }
  }
}

/** Parse all INSERT statements in sql into structured table data. */
export function parseInsertToRows(sql: string): TableData[] {
  const tableMap = new Map<string, TableData>();
  const lines = sql.split("\n");
  let buf = "";

  for (const line of lines) {
    buf += line.replace(/\r$/, "") + "\n";
    if (line.trimEnd().endsWith(";")) {
      const stmt = buf.trim();
      buf = "";
      if (stmt) processStatement(stmt, tableMap);
    }
  }
  const remaining = buf.trim();
  if (remaining) processStatement(remaining, tableMap);

  return Array.from(tableMap.values());
}

/** Escape a single CSV cell per RFC 4180. */
function csvEscape(val: string): string {
  if (val.includes(",") || val.includes('"') || val.includes("\n") || val.includes("\r")) {
    return '"' + val.replace(/"/g, '""') + '"';
  }
  return val;
}

/** Generate a CSV string for one table (header + rows, CRLF line endings). */
export function toCsv(table: TableData): string {
  const lines: string[] = [];
  if (table.columns.length > 0) {
    lines.push(table.columns.map(csvEscape).join(","));
  }
  for (const row of table.rows) {
    lines.push(row.map(csvEscape).join(","));
  }
  return lines.join("\r\n");
}

/** Package multiple tables as CSV files inside a ZIP Blob. */
export async function toCsvZip(tables: TableData[]): Promise<Blob> {
  const zip = new JSZip();
  for (const table of tables) {
    zip.file(`${table.tableName}.csv`, toCsv(table));
  }
  return zip.generateAsync({ type: "blob" });
}

/** Generate a multi-sheet .xlsx Blob — one Sheet per table. */
export async function toXlsx(tables: TableData[]): Promise<Blob> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  for (const table of tables) {
    const data = [table.columns, ...table.rows];
    const ws = XLSX.utils.aoa_to_sheet(data);
    XLSX.utils.book_append_sheet(wb, ws, table.tableName.slice(0, 31));
  }
  const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

/** Trigger a browser file download from a Blob. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

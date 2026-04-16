/**
 * Parse a single CSV row per RFC 4180.
 * Handles quoted fields (embedded commas, double-quote escaping "").
 * Does NOT handle multi-line quoted fields (splits are done on \n first).
 */
function parseCsvRow(row: string): string[] {
  const fields: string[] = [];
  let i = 0;
  let lastWasSeparator = false;

  while (i < row.length) {
    if (row[i] === '"') {
      i++;
      let val = "";
      while (i < row.length) {
        if (row[i] === '"' && row[i + 1] === '"') {
          val += '"';
          i += 2;
        } else if (row[i] === '"') {
          i++;
          break;
        } else {
          val += row[i++];
        }
      }
      fields.push(val);
      if (row[i] === ",") {
        i++;
        lastWasSeparator = true;
      } else {
        lastWasSeparator = false;
      }
    } else {
      const commaIdx = row.indexOf(",", i);
      if (commaIdx === -1) {
        fields.push(row.slice(i));
        lastWasSeparator = false;
        break;
      } else {
        fields.push(row.slice(i, commaIdx));
        i = commaIdx + 1;
        lastWasSeparator = true;
      }
    }
  }

  if (lastWasSeparator) fields.push("");

  return fields;
}

export interface CsvToSqlOptions {
  /** Target SQL table name. Backticks are stripped automatically. */
  tableName: string;
  /**
   * When true, the first row is treated as data and column names become
   * col1, col2, … Default: false.
   */
  noHeader?: boolean;
  /**
   * Number of rows per batch INSERT statement.
   * 0 (default) = one INSERT per row.
   */
  batchSize?: number;
  /**
   * Auto-detect numeric columns: if every non-empty value in a column is a
   * valid number, the values are written without quotes. Default: true.
   */
  detectNumeric?: boolean;
}

const NUMERIC_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * Convert CSV text to SQL INSERT statements.
 * - Strips leading UTF-8 BOM automatically.
 * - First row is column headers unless noHeader=true.
 * - Empty cells → NULL.
 * - Numeric columns (when detectNumeric=true) → unquoted values.
 * - Single quotes in string values are escaped as ''.
 */
export function csvToSql(csvText: string, options: CsvToSqlOptions): string {
  const { tableName, noHeader = false, batchSize = 0, detectNumeric = true } =
    options;

  const text = csvText.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/);

  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  const safeTable = tableName.replace(/`/g, "");

  let headers: string[];
  let dataLines: string[];

  if (noHeader) {
    if (lines.length < 1) return "";
    const colCount = parseCsvRow(lines[0]).length;
    headers = Array.from({ length: colCount }, (_, i) => `col${i + 1}`);
    dataLines = lines;
  } else {
    if (lines.length < 2) return "";
    headers = parseCsvRow(lines[0]);
    dataLines = lines.slice(1);
  }

  const colList = headers.map((h) => `\`${h.replace(/`/g, "")}\``).join(", ");

  // Parse all data rows up front (needed for numeric detection)
  const allRows: string[][] = [];
  for (const line of dataLines) {
    if (!line.trim()) continue;
    const values = parseCsvRow(line);
    while (values.length < headers.length) values.push("");
    allRows.push(values.slice(0, headers.length));
  }

  if (allRows.length === 0) return "";

  // Per-column numeric detection: a column is numeric when every non-empty
  // value matches the number pattern.
  const isNumeric: boolean[] = headers.map((_, ci) => {
    if (!detectNumeric) return false;
    return allRows.every((row) => row[ci] === "" || NUMERIC_RE.test(row[ci]));
  });

  function fmtVal(val: string, ci: number): string {
    if (val === "") return "NULL";
    if (isNumeric[ci]) return val;
    return `'${val.replace(/'/g, "''")}'`;
  }

  const size = batchSize && batchSize > 0 ? batchSize : 0;
  const stmts: string[] = [];

  if (!size) {
    // One INSERT per row
    for (const row of allRows) {
      const valList = row.map((v, ci) => fmtVal(v, ci)).join(", ");
      stmts.push(
        `INSERT INTO \`${safeTable}\` (${colList}) VALUES (${valList});`
      );
    }
  } else {
    // Batch INSERT: N rows per statement
    for (let i = 0; i < allRows.length; i += size) {
      const batch = allRows.slice(i, i + size);
      const rowClauses = batch
        .map((row) => `  (${row.map((v, ci) => fmtVal(v, ci)).join(", ")})`)
        .join(",\n");
      stmts.push(
        `INSERT INTO \`${safeTable}\` (${colList}) VALUES\n${rowClauses};`
      );
    }
  }

  return stmts.join("\n");
}

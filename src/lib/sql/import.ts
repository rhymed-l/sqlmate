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
      // Quoted field
      i++; // skip opening quote
      let val = "";
      while (i < row.length) {
        if (row[i] === '"' && row[i + 1] === '"') {
          val += '"';
          i += 2;
        } else if (row[i] === '"') {
          i++; // skip closing quote
          break;
        } else {
          val += row[i++];
        }
      }
      fields.push(val);
      if (row[i] === ",") {
        i++; // skip comma after closing quote
        lastWasSeparator = true;
      } else {
        lastWasSeparator = false;
      }
    } else {
      // Unquoted field
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

  // Trailing comma means a final empty field
  if (lastWasSeparator) fields.push("");

  return fields;
}

/**
 * Convert CSV text to SQL INSERT statements.
 * - First row is treated as column headers.
 * - Empty cells become NULL; all other values become single-quoted strings.
 * - Single quotes in values are escaped as ''.
 */
export function csvToSql(csvText: string, tableName: string): string {
  // Strip UTF-8 BOM if present
  const text = csvText.replace(/^\uFEFF/, "");

  const lines = text.split(/\r?\n/);

  // Remove trailing blank lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  if (lines.length < 2) return "";

  const headers = parseCsvRow(lines[0]);
  const colList = headers
    .map((h) => `\`${h.replace(/`/g, "")}\``)
    .join(", ");

  // Sanitize tableName by removing backticks
  const safeTable = tableName.replace(/`/g, "");

  const stmts: string[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const values = parseCsvRow(line);
    // Pad short rows to match header count
    while (values.length < headers.length) values.push("");

    const valList = values
      .slice(0, headers.length)
      .map((v) => (v === "" ? "NULL" : `'${v.replace(/'/g, "''")}'`))
      .join(", ");

    stmts.push(`INSERT INTO \`${safeTable}\` (${colList}) VALUES (${valList});`);
  }

  return stmts.join("\n");
}

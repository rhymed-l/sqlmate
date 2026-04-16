import { parseInsertLine } from "./dedupe";

export interface OffsetRule {
  column: string;    // column name (takes priority if set)
  colIndex?: number; // 1-based, used when column name not provided
  offset: number;    // integer, may be negative
}

export interface OffsetResult {
  sql: string;
  modifiedCount: number; // lines where at least one column was offset
  skippedCount: number;  // lines where a target column value was non-numeric
  warnings: string[];
}

// Reconstruct a VALUES(...) string from tokens, applying offsets.
// Returns { valStr, modified, skipped }.
function applyOffsets(
  values: string[],
  columns: string[] | null,
  rules: OffsetRule[]
): { valStr: string; modified: boolean; skippedCols: string[] } {
  const result = [...values];
  let modified = false;
  const skippedCols: string[] = [];

  for (const rule of rules) {
    let idx = -1;
    if (rule.column && columns) {
      idx = columns.findIndex(
        (c) => c.toLowerCase() === rule.column.toLowerCase()
      );
    } else if (rule.colIndex !== undefined) {
      idx = rule.colIndex - 1;
    }
    if (idx === -1 || idx >= result.length) continue;

    const raw = result[idx];
    const num = Number(raw);
    if (!Number.isFinite(num) || raw.startsWith("'")) {
      skippedCols.push(rule.column || `col${idx + 1}`);
      continue;
    }

    const newVal = num + rule.offset;
    result[idx] = String(newVal);
    modified = true;
  }

  // Reconstruct VALUES string — preserve original quote style for non-offset tokens
  const valStr = result.join(", ");
  return { valStr, modified, skippedCols };
}

// Re-serialise a parsed INSERT line with new values.
function rebuildInsertLine(
  _line: string,
  tableName: string,
  columns: string[] | null,
  newValues: string[]
): string {
  const colPart =
    columns !== null
      ? ` (${columns.map((c) => `\`${c}\``).join(", ")})`
      : "";
  const valPart = newValues.join(", ");
  return `INSERT INTO \`${tableName}\`${colPart} VALUES (${valPart});`;
}

export function offsetSql(sql: string, rules: OffsetRule[]): OffsetResult {
  if (rules.length === 0) {
    return { sql, modifiedCount: 0, skippedCount: 0, warnings: [] };
  }

  const lines = sql.split("\n");
  let modifiedCount = 0;
  let skippedCount = 0;
  const warningSet = new Set<string>();

  const outputLines = lines.map((line) => {
    const trimmed = line.trimEnd();
    if (!/^INSERT\s+INTO\s+/i.test(trimmed)) return trimmed;

    const parsed = parseInsertLine(trimmed);
    if (!parsed) return trimmed;

    const { tableName, columns, values } = parsed;
    const { valStr: _, modified, skippedCols } = applyOffsets(values, columns, rules);

    if (skippedCols.length > 0) {
      skippedCount++;
      skippedCols.forEach((c) =>
        warningSet.add(`列 "${c}" 存在非数值，已跳过偏移`)
      );
    }

    if (!modified && skippedCols.length === 0) return trimmed;

    // Re-apply to get newValues array
    const newValues = [...values];
    for (const rule of rules) {
      let idx = -1;
      if (rule.column && columns) {
        idx = columns.findIndex(
          (c) => c.toLowerCase() === rule.column.toLowerCase()
        );
      } else if (rule.colIndex !== undefined) {
        idx = rule.colIndex - 1;
      }
      if (idx === -1 || idx >= newValues.length) continue;
      const raw = newValues[idx];
      const num = Number(raw);
      if (!Number.isFinite(num) || raw.startsWith("'")) continue;
      newValues[idx] = String(num + rule.offset);
    }

    if (modified) modifiedCount++;
    return rebuildInsertLine(trimmed, tableName, columns, newValues);
  });

  // Trim trailing blank lines
  while (outputLines.length > 0 && outputLines[outputLines.length - 1].trim() === "") {
    outputLines.pop();
  }

  return {
    sql: outputLines.join("\n"),
    modifiedCount,
    skippedCount,
    warnings: Array.from(warningSet),
  };
}

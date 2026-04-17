import { parseInsertLine, splitMultiRowInsert } from "./dedupe";

export type ConvertMode = "update" | "mysql_upsert" | "pg_upsert" | "insert_ignore";

export interface ConvertOptions {
  pkColumn?: string;    // primary key column name
  pkColIndex?: number;  // 1-based, used when no column list
  mode: ConvertMode;
  excludeColumns?: string[]; // columns to skip in SET clause
}

export interface ConvertResult {
  sql: string;
  convertedCount: number;
  skippedCount: number; // lines where pk could not be resolved
}

function buildSetClause(
  columns: string[],
  values: string[],
  pkIdx: number,
  excludeSet: Set<string>
): string {
  return columns
    .map((col, i) => {
      if (i === pkIdx) return null;
      if (excludeSet.has(col.toLowerCase())) return null;
      return `\`${col}\` = ${values[i] ?? "NULL"}`;
    })
    .filter(Boolean)
    .join(", ");
}

function convertLine(line: string, options: ConvertOptions): string | null {
  const parsed = parseInsertLine(line);
  if (!parsed) return null;

  const { tableName, columns, values } = parsed;
  const { pkColumn, pkColIndex, mode, excludeColumns = [] } = options;
  const excludeSet = new Set(excludeColumns.map((c) => c.toLowerCase()));

  let pkIdx = -1;
  if (pkColumn && columns) {
    pkIdx = columns.findIndex((c) => c.toLowerCase() === pkColumn.toLowerCase());
  } else if (pkColIndex !== undefined) {
    pkIdx = pkColIndex - 1;
  }

  if (pkIdx === -1 || pkIdx >= values.length) return null;

  const pkVal = values[pkIdx];

  if (mode === "update") {
    if (!columns) return null; // UPDATE requires column names
    const setClause = buildSetClause(columns, values, pkIdx, excludeSet);
    if (!setClause) return null;
    const pkColName = columns[pkIdx];
    return `UPDATE \`${tableName}\` SET ${setClause} WHERE \`${pkColName}\` = ${pkVal};`;
  }

  if (mode === "mysql_upsert") {
    // INSERT INTO `t` (cols) VALUES (...) ON DUPLICATE KEY UPDATE col=val, ...
    const colList = columns
      ? `(${columns.map((c) => `\`${c}\``).join(", ")}) `
      : "";
    const valList = values.join(", ");

    let updatePart: string;
    if (columns) {
      updatePart = columns
        .map((col, i) => {
          if (i === pkIdx) return null;
          if (excludeSet.has(col.toLowerCase())) return null;
          return `\`${col}\` = VALUES(\`${col}\`)`;
        })
        .filter(Boolean)
        .join(", ");
    } else {
      updatePart = `/* specify columns for ON DUPLICATE KEY UPDATE */`;
    }

    return `INSERT INTO \`${tableName}\` ${colList}VALUES (${valList}) ON DUPLICATE KEY UPDATE ${updatePart};`;
  }

  if (mode === "pg_upsert") {
    // INSERT INTO "t" (cols) VALUES (...) ON CONFLICT (pk) DO UPDATE SET col=EXCLUDED.col, ...
    const colList = columns
      ? `(${columns.map((c) => `"${c}"`).join(", ")}) `
      : "";
    const valList = values.join(", ");
    const pkColName = columns ? `"${columns[pkIdx]}"` : `col${pkIdx + 1}`;

    let updatePart: string;
    if (columns) {
      updatePart = columns
        .map((col, i) => {
          if (i === pkIdx) return null;
          if (excludeSet.has(col.toLowerCase())) return null;
          return `"${col}" = EXCLUDED."${col}"`;
        })
        .filter(Boolean)
        .join(", ");
    } else {
      updatePart = `/* specify columns */`;
    }

    return `INSERT INTO "${tableName}" ${colList}VALUES (${valList}) ON CONFLICT (${pkColName}) DO UPDATE SET ${updatePart};`;
  }

  return null;
}

export function convertStatements(sql: string, options: ConvertOptions): ConvertResult {
  // Expand multi-row INSERTs for modes that rewrite values; insert_ignore can
  // work on the raw line but expansion keeps behaviour consistent.
  const lines = sql.split("\n").flatMap(splitMultiRowInsert);
  let convertedCount = 0;
  let skippedCount = 0;

  const outputLines = lines.map((line) => {
    const trimmed = line.trimEnd();
    if (!/INSERT/i.test(trimmed)) return trimmed;

    // insert_ignore: inject IGNORE, handle optional modifiers, skip if already present
    if (options.mode === "insert_ignore") {
      if (/INSERT\s+IGNORE\b/i.test(trimmed)) return trimmed; // already has IGNORE
      const replaced = trimmed.replace(
        /INSERT(\s+(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY))?\s+INTO\b/i,
        (_, mod) => `INSERT${mod ?? ""} IGNORE INTO`,
      );
      if (replaced !== trimmed) { convertedCount++; return replaced; }
      return trimmed;
    }

    if (!/^INSERT\s+INTO\s+/i.test(trimmed)) return trimmed;
    const converted = convertLine(trimmed, options);
    if (converted !== null) {
      convertedCount++;
      return converted;
    } else {
      // Could not convert (no pk, no columns for UPDATE) — keep original
      skippedCount++;
      return trimmed;
    }
  });

  while (outputLines.length > 0 && outputLines[outputLines.length - 1].trim() === "") {
    outputLines.pop();
  }

  return { sql: outputLines.join("\n"), convertedCount, skippedCount };
}

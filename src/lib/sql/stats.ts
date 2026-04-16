export interface TableStat {
  tableName: string;
  rowCount: number;
  estimatedBytes: number;
}

export interface SqlStats {
  tables: TableStat[];
  totalRows: number;
  totalStatements: number; // INSERT count
  inputBytes: number;
  durationMs: number;
}

// Parse table name from an INSERT INTO line.
// Returns null for non-INSERT lines.
function extractTableName(line: string): string | null {
  const m = line.match(/^INSERT\s+INTO\s+`?([^`\s(]+)`?/i);
  return m ? m[1] : null;
}

export function analyzeSql(sql: string): SqlStats {
  const start = performance.now();
  const inputBytes = new TextEncoder().encode(sql).length;

  const tableMap = new Map<string, { rowCount: number; bytes: number }>();
  let totalStatements = 0;

  const lines = sql.split("\n");
  for (const line of lines) {
    const trimmed = line.trimEnd();
    const tableName = extractTableName(trimmed);
    if (tableName === null) continue;

    totalStatements++;
    const lineBytes = new TextEncoder().encode(trimmed).length;

    const existing = tableMap.get(tableName);
    if (existing) {
      existing.rowCount++;
      existing.bytes += lineBytes;
    } else {
      tableMap.set(tableName, { rowCount: 1, bytes: lineBytes });
    }
  }

  const tables: TableStat[] = Array.from(tableMap.entries()).map(
    ([tableName, { rowCount, bytes }]) => ({
      tableName,
      rowCount,
      estimatedBytes: bytes,
    })
  );

  const durationMs = Math.round(performance.now() - start);

  return {
    tables,
    totalRows: totalStatements,
    totalStatements,
    inputBytes,
    durationMs,
  };
}

// Format bytes for display (B / KB / MB)
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// Render stats as Markdown table
export function statsToMarkdown(stats: SqlStats): string {
  const header = "| 表名 | 行数 | 估算大小 |\n|------|------|----------|\n";
  const rows = stats.tables
    .map(
      (t) =>
        `| ${t.tableName} | ${t.rowCount.toLocaleString()} | ${formatBytes(t.estimatedBytes)} |`
    )
    .join("\n");
  return header + rows;
}

// Render stats as CSV
export function statsToCsv(stats: SqlStats): string {
  const header = "table_name,row_count,estimated_bytes\n";
  const rows = stats.tables
    .map((t) => `${t.tableName},${t.rowCount},${t.estimatedBytes}`)
    .join("\n");
  return header + rows;
}

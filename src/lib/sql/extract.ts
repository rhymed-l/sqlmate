const INSERT_RE =
  /INSERT\s+(?:LOW_PRIORITY\s+|DELAYED\s+|HIGH_PRIORITY\s+|IGNORE\s+)?INTO\s+((?:`[^`]+`|\w+)(?:\.(?:`[^`]+`|\w+))?)/gi;

/** Strip backticks and schema prefix, lowercase. */
function normalizeTableName(raw: string): string {
  const stripped = raw.replace(/`/g, "");
  const parts = stripped.split(".");
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

/** Scan all INSERT statements and return table name → count. */
export function scanTables(sql: string): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  INSERT_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INSERT_RE.exec(sql)) !== null) {
    const name = normalizeTableName(match[1]);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
}

/** Return only INSERT statements whose table is in `tables`. */
export function extractTables(sql: string, tables: string[]): string {
  const targetSet = new Set(tables.map((t) => t.toLowerCase().trim()));
  const lines = sql.split("\n");
  const results: string[] = [];
  let buf = "";

  const tryAppend = (stmt: string) => {
    INSERT_RE.lastIndex = 0;
    const m = INSERT_RE.exec(stmt);
    if (m && targetSet.has(normalizeTableName(m[1]))) {
      results.push(stmt);
    }
  };

  for (const line of lines) {
    buf += line + "\n";
    if (line.trimEnd().endsWith(";")) {
      const stmt = buf.trim();
      buf = "";
      if (stmt) tryAppend(stmt);
    }
  }
  const remaining = buf.trim();
  if (remaining) tryAppend(remaining);

  return results.join("\n");
}

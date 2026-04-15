function makeInsertRe(): RegExp {
  return /INSERT\s+(?:LOW_PRIORITY\s+|DELAYED\s+|HIGH_PRIORITY\s+|IGNORE\s+)?INTO\s+((?:`[^`]+`|\w+)(?:\.(?:`[^`]+`|\w+))?)/gi;
}

const INSERT_ONCE_RE =
  /INSERT\s+(?:LOW_PRIORITY\s+|DELAYED\s+|HIGH_PRIORITY\s+|IGNORE\s+)?INTO\s+((?:`[^`]+`|\w+)(?:\.(?:`[^`]+`|\w+))?)/i;

/** Strip backticks and schema prefix, lowercase. */
function normalizeTableName(raw: string): string {
  const stripped = raw.replace(/`/g, "");
  const parts = stripped.split(".");
  return (parts[parts.length - 1] ?? "").toLowerCase();
}

/**
 * Scan all INSERT statements and return table names with statement counts.
 * Note: counts statements, not individual rows — a batch INSERT with 1000 VALUES
 * counts as 1. This is intentional: the UI shows statement counts.
 */
export function scanTables(sql: string): { name: string; count: number }[] {
  const counts = new Map<string, number>();
  const re = makeInsertRe();
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) {
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
    const m = INSERT_ONCE_RE.exec(stmt);
    if (m && targetSet.has(normalizeTableName(m[1]))) {
      results.push(stmt);
    }
  };

  // LIMITATION: statement boundary detection is line-based (line ending with ';').
  // Semicolons inside string literals that fall at end of a line will cause incorrect splits.
  // This matches the behaviour of the Rust streaming commands and is acceptable for typical SQL dumps.
  for (const line of lines) {
    buf += line.replace(/\r$/, "") + "\n";
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

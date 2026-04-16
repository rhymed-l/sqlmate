export interface DedupeOptions {
  keyColumn?: string;    // column name (for INSERTs with column list)
  keyColIndex?: number;  // 1-based index (for INSERTs without column list)
  keepLast?: boolean;    // default true
}

export interface DedupeResult {
  sql: string;
  originalCount: number;
  keptCount: number;
  removedCount: number;
}

interface ParsedInsert {
  tableName: string;
  columns: string[] | null;
  values: string[];
}

// Tokenize a SQL values string like `'Alice', 'O''Brien', 42, NULL`
// Returns array of raw value strings (with surrounding quotes intact).
export function parseSqlValues(valStr: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < valStr.length) {
    // skip whitespace
    while (i < valStr.length && /\s/.test(valStr[i])) i++;
    if (i >= valStr.length) break;

    if (valStr[i] === "'") {
      // single-quoted string — handle '' escaping
      let j = i + 1;
      while (j < valStr.length) {
        if (valStr[j] === "'" && valStr[j + 1] === "'") {
          j += 2;
        } else if (valStr[j] === "'") {
          j++;
          break;
        } else {
          j++;
        }
      }
      tokens.push(valStr.slice(i, j));
      i = j;
    } else {
      // unquoted token (NULL, number, etc.)
      let j = i;
      while (j < valStr.length && valStr[j] !== "," && !/\s/.test(valStr[j])) j++;
      tokens.push(valStr.slice(i, j));
      i = j;
    }

    // skip whitespace then comma
    while (i < valStr.length && /\s/.test(valStr[i])) i++;
    if (i < valStr.length && valStr[i] === ",") i++;
  }
  return tokens;
}

// Parse a single INSERT line.
// Supports:
//   INSERT INTO `t` (`a`, `b`) VALUES ('x', 1);
//   INSERT INTO `t` VALUES ('x', 1);
export function parseInsertLine(line: string): ParsedInsert | null {
  // Match INSERT INTO `tableName` (optional column list) VALUES (values)
  const re =
    /^INSERT\s+INTO\s+`?([^`\s(]+)`?\s*(?:\(([^)]*)\)\s*)?VALUES\s*\(([^)]*(?:\)[^;]*\()*[^)]*)\)/i;
  const m = line.match(re);
  if (!m) return null;

  const tableName = m[1];

  let columns: string[] | null = null;
  if (m[2] !== undefined && m[2].trim() !== "") {
    columns = m[2].split(",").map((c) => c.trim().replace(/^`|`$/g, ""));
  }

  // Find the VALUES ( ... ) portion more reliably
  const valuesStart = line.search(/VALUES\s*\(/i);
  if (valuesStart === -1) return null;
  const parenOpen = line.indexOf("(", valuesStart);
  const parenClose = line.lastIndexOf(")");
  if (parenOpen === -1 || parenClose === -1 || parenClose <= parenOpen) return null;

  const valStr = line.slice(parenOpen + 1, parenClose);
  const values = parseSqlValues(valStr);

  return { tableName, columns, values };
}

// Extract the dedup key value from a parsed INSERT.
// Returns null if key cannot be resolved (unknown column, out-of-range index).
function extractKey(
  parsed: ParsedInsert,
  keyColumn: string | undefined,
  keyColIndex: number | undefined
): string | null {
  if (keyColumn !== undefined) {
    if (parsed.columns === null) return null;
    const idx = parsed.columns.findIndex(
      (c) => c.toLowerCase() === keyColumn.toLowerCase()
    );
    if (idx === -1) return null;
    return parsed.values[idx] ?? null;
  }

  if (keyColIndex !== undefined) {
    const idx = keyColIndex - 1; // convert 1-based to 0-based
    return parsed.values[idx] ?? null;
  }

  return null;
}

export function dedupeSql(sql: string, options: DedupeOptions): DedupeResult {
  const { keyColumn, keyColIndex, keepLast = true } = options;
  const lines = sql.split("\n");

  // Pass 1 — build map from composite key → last (or first) line index
  // composite key: "tableName\0keyValue"
  const keyToIndex = new Map<string, number>();
  let originalCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd();
    if (!/^INSERT\s+INTO\s+/i.test(trimmed)) continue;

    const parsed = parseInsertLine(trimmed);
    if (!parsed) continue;

    originalCount++;

    const keyVal = extractKey(parsed, keyColumn, keyColIndex);
    if (keyVal === null) {
      // Cannot deduplicate this line — keep it unconditionally
      // Use a unique key per line so it's never overwritten
      keyToIndex.set(`\0unique\0${i}`, i);
      continue;
    }

    const compositeKey = `${parsed.tableName}\0${keyVal}`;
    if (!keyToIndex.has(compositeKey) || keepLast) {
      keyToIndex.set(compositeKey, i);
    }
  }

  const keptLineIndices = new Set(keyToIndex.values());

  // Pass 2 — build output
  const outputLines: string[] = [];
  let keptCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd();
    if (/^INSERT\s+INTO\s+/i.test(trimmed) && parseInsertLine(trimmed) !== null) {
      if (keptLineIndices.has(i)) {
        outputLines.push(trimmed);
        keptCount++;
      }
      // else: skip (deduplicated)
    } else {
      // Non-INSERT lines (comments, blanks, DDL) are always kept
      outputLines.push(trimmed);
    }
  }

  // Trim trailing blank lines
  while (outputLines.length > 0 && outputLines[outputLines.length - 1].trim() === "") {
    outputLines.pop();
  }

  const removedCount = originalCount - keptCount;

  return {
    sql: outputLines.join("\n"),
    originalCount,
    keptCount,
    removedCount,
  };
}

// DDL Diff: Parse two CREATE TABLE statements, compute structural differences,
// and generate ALTER TABLE SQL for the target dialect.

export type DdlDialect = "mysql" | "postgresql" | "oracle";

// ─── Data Structures ─────────────────────────────────────────────────────────

export interface ColumnDef {
  name: string;       // lowercase-normalised column name
  rawName: string;    // original name (preserves casing / quoting)
  fullDef: string;    // full column definition after the name (e.g. "VARCHAR(255) NOT NULL DEFAULT ''")
}

export type IndexType = "PRIMARY" | "UNIQUE" | "INDEX" | "FULLTEXT" | "SPATIAL";

export interface IndexDef {
  name: string;         // index name (lowercase-normalised); "PRIMARY" for PK
  rawName: string;      // original
  type: IndexType;
  columns: string[];    // column names (lowercase-normalised)
}

export interface TableDef {
  tableName: string;
  rawTableName: string;
  columns: ColumnDef[];
  indexes: IndexDef[];
}

export interface ColumnChange {
  kind: "added" | "removed" | "modified";
  column: ColumnDef;           // "to" side for added/modified, "from" side for removed
  fromColumn?: ColumnDef;      // only for modified
}

export interface IndexChange {
  kind: "added" | "removed" | "modified";
  index: IndexDef;
  fromIndex?: IndexDef;
}

export interface DdlDiffResult {
  fromTableName: string;
  toTableName: string;
  columnChanges: ColumnChange[];
  indexChanges: IndexChange[];
  hasChanges: boolean;
}

// ─── DDL Parser ──────────────────────────────────────────────────────────────

/** Strip SQL line comments and block comments from a string. */
function stripComments(sql: string): string {
  // Block comments /* ... */
  sql = sql.replace(/\/\*[\s\S]*?\*\//g, " ");
  // Line comments -- ...
  sql = sql.replace(/--[^\n]*/g, " ");
  return sql;
}

/** Normalise a quoted/unquoted identifier to lowercase plain text. */
function normaliseIdent(raw: string): string {
  return raw.replace(/^[`"[\]]|[`"[\]]$/g, "").toLowerCase().trim();
}

/** Extract the raw identifier (backtick, double-quote, bracket, or bare word). */
const IDENT_RE = /(`[^`]+`|"[^"]+"|[\w$]+)/;

/**
 * Tokenise the body of a CREATE TABLE statement (the part inside the outer
 * parentheses) into individual column / index definition strings.
 *
 * We must respect nested parentheses (e.g. DEFAULT (expr), column type params).
 */
function splitCreateTableBody(body: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let current = "";

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "(") {
      depth++;
      current += ch;
    } else if (ch === ")") {
      depth--;
      current += ch;
    } else if (ch === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) items.push(trimmed);
      current = "";
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed) items.push(trimmed);
  return items;
}

/**
 * Parse a CREATE TABLE statement into a TableDef.
 * Throws if the input contains more than one CREATE TABLE or none.
 */
export function parseDDL(sql: string): TableDef {
  const cleaned = stripComments(sql);

  // Find all CREATE TABLE occurrences
  const createRe = /CREATE\s+(?:TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(`[^`]+`|"[^"]+"|[\w$]+)/gi;
  const matches = [...cleaned.matchAll(createRe)];

  if (matches.length === 0) {
    throw new Error("未找到 CREATE TABLE 语句，请输入有效的 DDL");
  }
  if (matches.length > 1) {
    throw new Error("检测到多个 CREATE TABLE，请只输入一张表的 DDL");
  }

  const rawTableName = matches[0][1];
  const tableName = normaliseIdent(rawTableName);

  // Extract the outer parentheses body
  const startIdx = cleaned.indexOf("(", matches[0].index!);
  if (startIdx === -1) throw new Error("CREATE TABLE 语句格式不正确：缺少 '('");

  let depth = 0;
  let endIdx = -1;
  for (let i = startIdx; i < cleaned.length; i++) {
    if (cleaned[i] === "(") depth++;
    else if (cleaned[i] === ")") {
      depth--;
      if (depth === 0) { endIdx = i; break; }
    }
  }
  if (endIdx === -1) throw new Error("CREATE TABLE 语句括号不匹配");

  const body = cleaned.slice(startIdx + 1, endIdx);
  const items = splitCreateTableBody(body);

  const columns: ColumnDef[] = [];
  const indexes: IndexDef[] = [];

  for (const item of items) {
    const upper = item.trimStart().toUpperCase();

    // ── Index / Key definitions ──────────────────────────────────────────
    if (upper.startsWith("PRIMARY KEY")) {
      const cols = extractIndexColumns(item);
      indexes.push({ name: "primary", rawName: "PRIMARY KEY", type: "PRIMARY", columns: cols });
      continue;
    }
    if (upper.startsWith("UNIQUE KEY") || upper.startsWith("UNIQUE INDEX") || upper.startsWith("UNIQUE (")) {
      const { name, rawName } = extractIndexName(item, /UNIQUE\s+(?:KEY|INDEX)\s+/i);
      const cols = extractIndexColumns(item);
      indexes.push({ name, rawName, type: "UNIQUE", columns: cols });
      continue;
    }
    if (upper.startsWith("KEY ") || upper.startsWith("INDEX ")) {
      const { name, rawName } = extractIndexName(item, /(?:KEY|INDEX)\s+/i);
      const cols = extractIndexColumns(item);
      indexes.push({ name, rawName, type: "INDEX", columns: cols });
      continue;
    }
    if (upper.startsWith("FULLTEXT")) {
      const { name, rawName } = extractIndexName(item, /FULLTEXT\s+(?:KEY|INDEX)?\s*/i);
      const cols = extractIndexColumns(item);
      indexes.push({ name, rawName, type: "FULLTEXT", columns: cols });
      continue;
    }
    if (upper.startsWith("SPATIAL")) {
      const { name, rawName } = extractIndexName(item, /SPATIAL\s+(?:KEY|INDEX)?\s*/i);
      const cols = extractIndexColumns(item);
      indexes.push({ name, rawName, type: "SPATIAL", columns: cols });
      continue;
    }
    // Skip table-level CONSTRAINT lines (FK etc.) - keep columns only
    if (upper.startsWith("CONSTRAINT ") || upper.startsWith("FOREIGN KEY")) {
      continue;
    }

    // ── Column definition ────────────────────────────────────────────────
    const identMatch = item.trimStart().match(IDENT_RE);
    if (!identMatch) continue;

    const rawName = identMatch[0];
    const name = normaliseIdent(rawName);
    // fullDef = everything after the column name
    const afterName = item.trimStart().slice(identMatch.index! + rawName.length).trim();
    columns.push({ name, rawName, fullDef: afterName });
  }

  return { tableName, rawTableName, columns, indexes };
}

/** Extract column names from a "(...)" index column list. */
function extractIndexColumns(item: string): string[] {
  const m = item.match(/\(([^)]+)\)/);
  if (!m) return [];
  return m[1].split(",").map((c) => {
    // strip length specs like col(10) → col
    const bare = c.trim().replace(/\s*\(\d+\)\s*$/, "");
    return normaliseIdent(bare);
  });
}

/** Extract index name from a KEY/INDEX definition line. */
function extractIndexName(item: string, prefixRe: RegExp): { name: string; rawName: string } {
  const rest = item.trimStart().replace(prefixRe, "");
  const m = rest.match(/^(`[^`]+`|"[^"]+"|[\w$]+)/);
  if (!m) return { name: "unnamed", rawName: "unnamed" };
  const rawName = m[1];
  return { name: normaliseIdent(rawName), rawName };
}

// ─── Diff Engine ─────────────────────────────────────────────────────────────

/**
 * Compare two TableDef objects and return a DdlDiffResult.
 * @param includeIndexes - whether to include index diff
 */
export function diffDDL(
  from: TableDef,
  to: TableDef,
  includeIndexes = true
): DdlDiffResult {
  const columnChanges: ColumnChange[] = [];
  const indexChanges: IndexChange[] = [];

  // ── Column diff ──────────────────────────────────────────────────────────
  const fromColMap = new Map(from.columns.map((c) => [c.name, c]));
  const toColMap   = new Map(to.columns.map((c)   => [c.name, c]));

  // Added columns (in to, not in from)
  for (const col of to.columns) {
    if (!fromColMap.has(col.name)) {
      columnChanges.push({ kind: "added", column: col });
    }
  }
  // Removed columns (in from, not in to)
  for (const col of from.columns) {
    if (!toColMap.has(col.name)) {
      columnChanges.push({ kind: "removed", column: col });
    }
  }
  // Modified columns (same name, different fullDef normalised)
  for (const toCol of to.columns) {
    const fromCol = fromColMap.get(toCol.name);
    if (fromCol && normaliseFullDef(fromCol.fullDef) !== normaliseFullDef(toCol.fullDef)) {
      columnChanges.push({ kind: "modified", column: toCol, fromColumn: fromCol });
    }
  }

  // ── Index diff ───────────────────────────────────────────────────────────
  if (includeIndexes) {
    const fromIdxMap = new Map(from.indexes.map((i) => [i.name, i]));
    const toIdxMap   = new Map(to.indexes.map((i)   => [i.name, i]));

    for (const idx of to.indexes) {
      if (!fromIdxMap.has(idx.name)) {
        indexChanges.push({ kind: "added", index: idx });
      }
    }
    for (const idx of from.indexes) {
      if (!toIdxMap.has(idx.name)) {
        indexChanges.push({ kind: "removed", index: idx });
      }
    }
    for (const toIdx of to.indexes) {
      const fromIdx = fromIdxMap.get(toIdx.name);
      if (fromIdx && !indexDefsEqual(fromIdx, toIdx)) {
        indexChanges.push({ kind: "modified", index: toIdx, fromIndex: fromIdx });
      }
    }
  }

  return {
    fromTableName: from.tableName,
    toTableName: to.tableName,
    columnChanges,
    indexChanges,
    hasChanges: columnChanges.length > 0 || indexChanges.length > 0,
  };
}

/** Normalise a column fullDef for comparison: collapse whitespace, uppercase keywords. */
function normaliseFullDef(def: string): string {
  return def
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    // Normalise quoting around default strings so minor formatting diffs are ignored
    .replace(/DEFAULT\s+'([^']*)'/g, "DEFAULT '$1'");
}

function indexDefsEqual(a: IndexDef, b: IndexDef): boolean {
  return (
    a.type === b.type &&
    a.columns.length === b.columns.length &&
    a.columns.every((c, i) => c === b.columns[i])
  );
}

// ─── ALTER SQL Generator ──────────────────────────────────────────────────────

export function generateAlterSql(
  diff: DdlDiffResult,
  dialect: DdlDialect,
  /** Override the table name used in ALTER TABLE (defaults to diff.fromTableName). */
  targetTableName?: string
): string {
  const table = quoteIdent(targetTableName ?? diff.fromTableName, dialect);
  const stmts: string[] = [];

  // ── Column changes ───────────────────────────────────────────────────────
  for (const change of diff.columnChanges) {
    const colName = quoteIdent(change.column.rawName, dialect);

    if (change.kind === "added") {
      stmts.push(
        `ALTER TABLE ${table} ADD COLUMN ${colName} ${change.column.fullDef};`
      );
    } else if (change.kind === "removed") {
      stmts.push(
        `ALTER TABLE ${table} DROP COLUMN ${colName};`
      );
    } else if (change.kind === "modified" && change.fromColumn) {
      stmts.push(...generateModifyColumn(table, colName, change.column, dialect));
    }
  }

  // ── Index changes ────────────────────────────────────────────────────────
  for (const change of diff.indexChanges) {
    if (change.kind === "removed" || change.kind === "modified") {
      stmts.push(...generateDropIndex(table, change.fromIndex ?? change.index, dialect));
    }
    if (change.kind === "added" || change.kind === "modified") {
      stmts.push(...generateCreateIndex(table, change.index, dialect));
    }
  }

  return stmts.join("\n");
}

function quoteIdent(name: string, dialect: DdlDialect): string {
  // strip any existing quoting first
  const bare = name.replace(/^[`"[\]]|[`"[\]]$/g, "");
  if (dialect === "postgresql" || dialect === "oracle") return `"${bare}"`;
  return `\`${bare}\``;
}

function generateModifyColumn(
  table: string,
  colName: string,
  col: ColumnDef,
  dialect: DdlDialect
): string[] {
  switch (dialect) {
    case "mysql":
      return [`ALTER TABLE ${table} MODIFY COLUMN ${colName} ${col.fullDef};`];
    case "postgresql": {
      // For PG, we generate multiple ALTER COLUMN sub-statements
      // We do a best-effort parse of the fullDef to extract type and constraints
      const { typePart, notNull, defaultExpr } = parseColDef(col.fullDef);
      const stmts: string[] = [];
      stmts.push(`ALTER TABLE ${table} ALTER COLUMN ${colName} TYPE ${typePart};`);
      if (notNull !== null) {
        stmts.push(
          `ALTER TABLE ${table} ALTER COLUMN ${colName} ${notNull ? "SET NOT NULL" : "DROP NOT NULL"};`
        );
      }
      if (defaultExpr !== null) {
        if (defaultExpr === "") {
          stmts.push(`ALTER TABLE ${table} ALTER COLUMN ${colName} DROP DEFAULT;`);
        } else {
          stmts.push(`ALTER TABLE ${table} ALTER COLUMN ${colName} SET DEFAULT ${defaultExpr};`);
        }
      }
      return stmts;
    }
    case "oracle":
      return [`ALTER TABLE ${table} MODIFY ${colName} ${col.fullDef};`];
  }
}

/** Best-effort parse of a column fullDef to extract type, NOT NULL, DEFAULT. */
function parseColDef(fullDef: string): {
  typePart: string;
  notNull: boolean | null;
  defaultExpr: string | null;
} {
  let def = fullDef.trim();

  // Extract NOT NULL / NULL
  let notNull: boolean | null = null;
  if (/\bNOT\s+NULL\b/i.test(def)) { notNull = true; def = def.replace(/\bNOT\s+NULL\b/gi, "").trim(); }
  else if (/\bNULL\b/i.test(def)) { notNull = false; def = def.replace(/\bNULL\b/gi, "").trim(); }

  // Extract DEFAULT
  let defaultExpr: string | null = null;
  const defaultMatch = def.match(/\bDEFAULT\s+(.+?)(?:\s+(?:ON\s+UPDATE|AUTO_INCREMENT|COMMENT|CHARACTER\s+SET|COLLATE)\b|$)/i);
  if (defaultMatch) {
    defaultExpr = defaultMatch[1].trim();
    def = def.slice(0, defaultMatch.index).trim();
  }

  // Strip trailing MySQL-specific extras (AUTO_INCREMENT, COMMENT, etc.)
  def = def.replace(/\bAUTO_INCREMENT\b/gi, "").trim();
  def = def.replace(/\bCOMMENT\s+'[^']*'/gi, "").trim();

  return { typePart: def.trim(), notNull, defaultExpr };
}

function generateDropIndex(table: string, idx: IndexDef, dialect: DdlDialect): string[] {
  if (idx.type === "PRIMARY") {
    switch (dialect) {
      case "mysql":      return [`ALTER TABLE ${table} DROP PRIMARY KEY;`];
      case "postgresql": return [`ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey;`];
      case "oracle":     return [`ALTER TABLE ${table} DROP PRIMARY KEY;`];
    }
  }
  const idxName = quoteIdent(idx.rawName, dialect);
  switch (dialect) {
    case "mysql":      return [`ALTER TABLE ${table} DROP INDEX ${idxName};`];
    case "postgresql": return [`DROP INDEX IF EXISTS ${idxName};`];
    case "oracle":     return [`DROP INDEX ${idxName};`];
  }
}

function generateCreateIndex(table: string, idx: IndexDef, dialect: DdlDialect): string[] {
  const cols = idx.columns.map((c) => quoteIdent(c, dialect)).join(", ");

  if (idx.type === "PRIMARY") {
    return [`ALTER TABLE ${table} ADD PRIMARY KEY (${cols});`];
  }

  const idxName = quoteIdent(idx.rawName, dialect);
  const unique = idx.type === "UNIQUE" ? "UNIQUE " : "";

  switch (dialect) {
    case "mysql":
      return [`ALTER TABLE ${table} ADD ${unique}INDEX ${idxName} (${cols});`];
    case "postgresql":
    case "oracle":
      return [`CREATE ${unique}INDEX ${idxName} ON ${table} (${cols});`];
  }
}

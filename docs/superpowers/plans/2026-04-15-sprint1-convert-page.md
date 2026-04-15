# Sprint 1: 转换页（按表名抽取 + SQL→CSV/Excel）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 SQLMate 左侧导航新增「转换」入口，内含两个 Tab：Tab 1 按表名从 SQL 文件中抽取指定表的 INSERT 语句，Tab 2 将 INSERT 语句导出为 CSV 或 xlsx 文件。

**Architecture:** 小文件（≤10MB）走前端 JS 处理，大文件走 Rust 流式 Tauri 命令，沿用现有双轨模式。Convert.tsx 是顶层 Tab 壳，ExtractFlow / ExportFlow 是两个函数式子组件，各自管理自己的状态。

**Tech Stack:** React 19 + TypeScript（前端），Rust（大文件命令），xlsx（SheetJS，Excel 生成），jszip（多表 CSV 打包），vitest（前端单元测试）

---

## File Map

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/pages/Convert.tsx` | 新建 | Tab 壳 + ExtractFlow + ExportFlow 两个子流程 |
| `src/lib/sql/extract.ts` | 新建 | `scanTables` / `extractTables` 纯 JS 逻辑 |
| `src/lib/sql/extract.test.ts` | 新建 | 以上函数的 vitest 测试 |
| `src/lib/sql/export.ts` | 新建 | `parseInsertToRows` / `toCsv` / `toCsvZip` / `toXlsx` / `downloadBlob` |
| `src/lib/sql/export.test.ts` | 新建 | 以上函数的 vitest 测试（不含 toXlsx / toCsvZip，浏览器 API 依赖） |
| `src-tauri/src/commands/file.rs` | 修改 | 追加 `extract_by_tables` + `export_to_csv_file` 命令及辅助函数 |
| `src-tauri/src/lib.rs` | 修改 | 注册两个新命令 |
| `src/components/Sidebar.tsx` | 修改 | 新增 `convert` 导航项 |
| `src/App.tsx` | 修改 | 新增 `"convert"` 到 `PageId` 和 `PAGES` |

---

## Task 1: 安装依赖 + 导航接入

**Files:**
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`

- [ ] **Step 1: 安装 npm 依赖**

```bash
cd e:/projects/sqlmate
npm install xlsx jszip
```

期望输出：`added 2 packages` 或类似，无报错。

- [ ] **Step 2: 更新 Sidebar.tsx，新增「转换」导航项**

打开 `src/components/Sidebar.tsx`，修改 `NAV_ITEMS`（在 `format` 之后追加）和 import：

```tsx
import { GitMerge, Scissors, Files, Sparkles, ArrowLeftRight, Sun, Moon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";

interface NavItem {
  id: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { id: "merge", label: "合并", Icon: GitMerge },
  { id: "split", label: "拆分", Icon: Scissors },
  { id: "segment", label: "分割", Icon: Files },
  { id: "format", label: "格式化", Icon: Sparkles },
  { id: "convert", label: "转换", Icon: ArrowLeftRight },
];
```

其余 Sidebar.tsx 内容不变。

- [ ] **Step 3: 更新 App.tsx，注册 convert 页面**

```tsx
import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { Merge } from "@/pages/Merge";
import { Split } from "@/pages/Split";
import { Segment } from "@/pages/Segment";
import { Format } from "@/pages/Format";
import { Convert } from "@/pages/Convert";

type PageId = "merge" | "split" | "segment" | "format" | "convert";

const PAGES: Record<PageId, React.ComponentType> = {
  merge: Merge,
  split: Split,
  segment: Segment,
  format: Format,
  convert: Convert,
};

export default function App() {
  const [page, setPage] = useState<PageId>("merge");
  const Page = PAGES[page];

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden select-none">
      <Sidebar active={page} onNavigate={(id) => setPage(id as PageId)} />
      <main className="flex-1 overflow-y-auto">
        <Page />
      </main>
    </div>
  );
}
```

- [ ] **Step 4: 创建最小 Convert.tsx stub，让 App 能编译**

```tsx
export function Convert() {
  return <div className="p-6 text-sm text-muted-foreground">转换页（开发中）</div>;
}
```

- [ ] **Step 5: 验证编译**

```bash
npm run build 2>&1 | tail -20
```

期望：无 TypeScript 错误，build 成功。

- [ ] **Step 6: Commit**

```bash
git add src/components/Sidebar.tsx src/App.tsx src/pages/Convert.tsx package.json package-lock.json
git commit -m "feat: add Convert nav entry and install xlsx/jszip"
```

---

## Task 2: extract.ts — 纯 JS 抽取逻辑（TDD）

**Files:**
- Create: `src/lib/sql/extract.ts`
- Create: `src/lib/sql/extract.test.ts`

- [ ] **Step 1: 写失败测试 extract.test.ts**

```typescript
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { scanTables, extractTables } from "./extract";

describe("scanTables", () => {
  it("counts INSERT statements per table", () => {
    const sql = [
      "INSERT INTO users (id) VALUES (1);",
      "INSERT INTO users (id) VALUES (2);",
      "INSERT INTO orders (id) VALUES (10);",
    ].join("\n");
    const result = scanTables(sql);
    const users = result.find((r) => r.name === "users");
    const orders = result.find((r) => r.name === "orders");
    expect(users?.count).toBe(2);
    expect(orders?.count).toBe(1);
  });

  it("normalizes backtick and schema prefix", () => {
    const sql = "INSERT INTO `mydb`.`user_info` (id) VALUES (1);";
    const result = scanTables(sql);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("user_info");
  });

  it("is case-insensitive", () => {
    const sql = [
      "INSERT INTO Users (id) VALUES (1);",
      "INSERT INTO USERS (id) VALUES (2);",
    ].join("\n");
    const result = scanTables(sql);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(2);
  });

  it("returns empty array for no INSERT statements", () => {
    expect(scanTables("-- just a comment\nSELECT 1;")).toEqual([]);
  });
});

describe("extractTables", () => {
  it("keeps only statements for selected tables", () => {
    const sql = [
      "INSERT INTO users (id) VALUES (1);",
      "INSERT INTO orders (id) VALUES (10);",
      "INSERT INTO users (id) VALUES (2);",
    ].join("\n");
    const result = extractTables(sql, ["users"]);
    expect(result).toContain("INSERT INTO users");
    expect(result).not.toContain("INSERT INTO orders");
  });

  it("is case-insensitive on table names", () => {
    const sql = "INSERT INTO Users (id) VALUES (1);";
    const result = extractTables(sql, ["users"]);
    expect(result).toContain("INSERT INTO Users");
  });

  it("strips backticks when matching", () => {
    const sql = "INSERT INTO `user_info` (id) VALUES (1);";
    const result = extractTables(sql, ["user_info"]);
    expect(result).toContain("INSERT INTO `user_info`");
  });

  it("returns empty string when no tables match", () => {
    const sql = "INSERT INTO users (id) VALUES (1);";
    expect(extractTables(sql, ["orders"])).toBe("");
  });

  it("handles multi-line statements (semicolon on last line)", () => {
    const sql = [
      "INSERT INTO users (id, name) VALUES",
      "(1, 'Alice');",
    ].join("\n");
    const result = extractTables(sql, ["users"]);
    expect(result).toContain("INSERT INTO users");
  });
});
```

- [ ] **Step 2: 运行测试，确认全部失败**

```bash
npx vitest run src/lib/sql/extract.test.ts 2>&1 | tail -20
```

期望：`Cannot find module './extract'` 或类似报错。

- [ ] **Step 3: 实现 extract.ts**

```typescript
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
```

- [ ] **Step 4: 运行测试，确认全部通过**

```bash
npx vitest run src/lib/sql/extract.test.ts 2>&1 | tail -20
```

期望：`✓ extract.test.ts (9)` 全部绿色。

- [ ] **Step 5: Commit**

```bash
git add src/lib/sql/extract.ts src/lib/sql/extract.test.ts
git commit -m "feat: add extract.ts — scanTables + extractTables with tests"
```

---

## Task 3: export.ts — SQL→CSV/Excel 逻辑（TDD）

**Files:**
- Create: `src/lib/sql/export.ts`
- Create: `src/lib/sql/export.test.ts`

- [ ] **Step 1: 写失败测试 export.test.ts**

```typescript
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseInsertToRows, toCsv } from "./export";

describe("parseInsertToRows", () => {
  it("extracts column names and rows from INSERT with column list", () => {
    const sql = "INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob');";
    const [table] = parseInsertToRows(sql);
    expect(table.tableName).toBe("users");
    expect(table.columns).toEqual(["id", "name"]);
    expect(table.rows).toEqual([["1", "Alice"], ["2", "Bob"]]);
  });

  it("generates col1/col2 names when INSERT has no column list", () => {
    const sql = "INSERT INTO users VALUES (1, 'Alice');";
    const [table] = parseInsertToRows(sql);
    expect(table.columns).toEqual(["col1", "col2"]);
    expect(table.rows[0]).toEqual(["1", "Alice"]);
  });

  it("converts NULL to empty string", () => {
    const sql = "INSERT INTO t (a, b) VALUES (1, NULL);";
    const [table] = parseInsertToRows(sql);
    expect(table.rows[0][1]).toBe("");
  });

  it("handles multiple tables", () => {
    const sql = [
      "INSERT INTO users (id) VALUES (1);",
      "INSERT INTO orders (id) VALUES (10);",
    ].join("\n");
    const tables = parseInsertToRows(sql);
    expect(tables).toHaveLength(2);
    expect(tables.map((t) => t.tableName)).toContain("users");
    expect(tables.map((t) => t.tableName)).toContain("orders");
  });

  it("strips backticks from table and column names", () => {
    const sql = "INSERT INTO `user_info` (`id`, `full_name`) VALUES (1, 'Alice');";
    const [table] = parseInsertToRows(sql);
    expect(table.tableName).toBe("user_info");
    expect(table.columns).toEqual(["id", "full_name"]);
  });

  it("unescapes SQL string values", () => {
    const sql = "INSERT INTO t (v) VALUES ('it''s a test');";
    const [table] = parseInsertToRows(sql);
    expect(table.rows[0][0]).toBe("it's a test");
  });

  it("accumulates rows across multiple INSERT statements for same table", () => {
    const sql = [
      "INSERT INTO t (id) VALUES (1);",
      "INSERT INTO t (id) VALUES (2);",
    ].join("\n");
    const [table] = parseInsertToRows(sql);
    expect(table.rows).toHaveLength(2);
  });
});

describe("toCsv", () => {
  it("generates header + data rows separated by CRLF", () => {
    const table = { tableName: "t", columns: ["id", "name"], rows: [["1", "Alice"]] };
    expect(toCsv(table)).toBe("id,name\r\n1,Alice");
  });

  it("wraps values containing commas in double quotes", () => {
    const table = { tableName: "t", columns: ["v"], rows: [["a,b"]] };
    expect(toCsv(table)).toContain('"a,b"');
  });

  it("escapes internal double quotes as double-double-quote", () => {
    const table = { tableName: "t", columns: ["v"], rows: [['say "hi"']] };
    expect(toCsv(table)).toContain('"say ""hi"""');
  });

  it("wraps values containing newlines in double quotes", () => {
    const table = { tableName: "t", columns: ["v"], rows: [["line1\nline2"]] };
    expect(toCsv(table)).toContain('"line1\nline2"');
  });
});
```

- [ ] **Step 2: 运行测试，确认全部失败**

```bash
npx vitest run src/lib/sql/export.test.ts 2>&1 | tail -20
```

期望：`Cannot find module './export'` 或类似报错。

- [ ] **Step 3: 实现 export.ts**

```typescript
import * as XLSX from "xlsx";
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
    buf += line + "\n";
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
export function toXlsx(tables: TableData[]): Blob {
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
```

- [ ] **Step 4: 运行测试，确认全部通过**

```bash
npx vitest run src/lib/sql/export.test.ts 2>&1 | tail -20
```

期望：`✓ export.test.ts (11)` 全部绿色。

- [ ] **Step 5: Commit**

```bash
git add src/lib/sql/export.ts src/lib/sql/export.test.ts
git commit -m "feat: add export.ts — parseInsertToRows, toCsv, toCsvZip, toXlsx with tests"
```

---

## Task 4: Rust 命令 — extract_by_tables

**Files:**
- Modify: `src-tauri/src/commands/file.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在 file.rs 末尾追加辅助函数和 extract_by_tables 命令**

在 `src-tauri/src/commands/file.rs` 文件末尾（`split_file` 函数之后）追加：

```rust
// ─── shared helpers for new commands ──────────────────────────────────────

/// Strip backticks and schema prefix, return lowercase table name.
/// E.g. `` `db`.`User_Info` `` → `"user_info"`
fn normalize_table_name(raw: &str) -> String {
    let stripped = raw.replace('`', "");
    let parts: Vec<&str> = stripped.split('.').collect();
    parts.last().unwrap_or(&"").to_lowercase()
}

/// Escape a single CSV cell per RFC 4180.
fn csv_escape(val: &str) -> String {
    if val.contains(',') || val.contains('"') || val.contains('\n') || val.contains('\r') {
        format!("\"{}\"", val.replace('"', "\"\""))
    } else {
        val.to_string()
    }
}

/// Parse a raw SQL value token to a plain string.
/// NULL → ""; 'text' → text (un-escaping '' and \')
fn parse_sql_value(raw: &str) -> String {
    let t = raw.trim();
    if t.eq_ignore_ascii_case("NULL") {
        return String::new();
    }
    if t.starts_with('\'') && t.ends_with('\'') && t.len() >= 2 {
        return t[1..t.len() - 1]
            .replace("''", "'")
            .replace("\\'", "'");
    }
    t.to_string()
}

/// Convert a VALUES tuple byte slice `(a, 'b', NULL)` into a CSV row string.
fn tuple_to_csv_row(tuple: &[u8]) -> String {
    let s = match std::str::from_utf8(tuple) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    let inner = if s.starts_with('(') && s.ends_with(')') {
        &s[1..s.len() - 1]
    } else {
        s
    };
    let bytes = inner.as_bytes();
    let mut tokens: Vec<String> = Vec::new();
    let mut depth: i32 = 0;
    let mut in_str = false;
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if in_str {
            if b == b'\\' { i += 2; continue; }
            if b == b'\'' && i + 1 < bytes.len() && bytes[i + 1] == b'\'' { i += 2; continue; }
            if b == b'\'' { in_str = false; }
        } else {
            match b {
                b'\'' => in_str = true,
                b'(' => depth += 1,
                b')' => depth -= 1,
                b',' if depth == 0 => {
                    tokens.push(parse_sql_value(&inner[start..i]));
                    start = i + 1;
                }
                _ => {}
            }
        }
        i += 1;
    }
    tokens.push(parse_sql_value(&inner[start..]));
    tokens.iter().map(|t| csv_escape(t.as_str())).collect::<Vec<_>>().join(",")
}

// ─── streaming extract ─────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ExtractStats {
    pub matched_tables: usize,
    pub statement_count: usize,
}

/// Filter INSERT statements by table name (streaming, O(1) memory).
#[tauri::command]
pub async fn extract_by_tables(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    tables: Vec<String>,
) -> Result<ExtractStats, String> {
    // Normalize target table names for case-insensitive matching
    let target: std::collections::HashSet<String> =
        tables.iter().map(|t| normalize_table_name(t)).collect();

    let total_bytes = fs::metadata(&input_path).map(|m| m.len()).unwrap_or(0);
    let file = File::open(&input_path).map_err(|e| format!("无法打开文件: {}", e))?;
    let reader = BufReader::new(file);
    let out = File::create(&output_path).map_err(|e| format!("创建输出文件失败: {}", e))?;
    let mut writer = BufWriter::new(out);

    let mut stmt_buf = String::new();
    let mut bytes_read: u64 = 0;
    let mut last_percent: u8 = 0;
    let mut statement_count: usize = 0;
    let mut matched_set: std::collections::HashSet<String> =
        std::collections::HashSet::new();

    // Inline helper — takes explicit mutable refs to avoid closure capture issues
    // (same pattern used by existing flush_batch/process in merge_file)
    macro_rules! process_stmt {
        ($stmt:expr) => {{
            if let Some(h) = parse_insert_header($stmt) {
                let tname = normalize_table_name(&h.table_expr);
                if target.contains(&tname) {
                    writer.write_all($stmt.as_bytes()).map_err(|e| e.to_string())?;
                    writer.write_all(b"\n").map_err(|e| e.to_string())?;
                    statement_count += 1;
                    matched_set.insert(tname);
                }
            }
        }};
    }

    for line_result in reader.lines() {
        let line = line_result.map_err(|e| e.to_string())?;
        bytes_read += line.len() as u64 + 1;
        emit_progress(&app, bytes_read, total_bytes, &mut last_percent);
        stmt_buf.push_str(&line);
        stmt_buf.push('\n');

        if line.trim_end().ends_with(';') {
            let stmt = stmt_buf.trim().to_string();
            stmt_buf.clear();
            if !stmt.is_empty() {
                process_stmt!(&stmt);
            }
        }
    }
    let remaining = stmt_buf.trim().to_string();
    if !remaining.is_empty() {
        process_stmt!(&remaining);
    }

    writer.flush().map_err(|e| e.to_string())?;

    Ok(ExtractStats {
        matched_tables: matched_set.len(),
        statement_count,
    })
}
```

- [ ] **Step 2: 注册 extract_by_tables 到 lib.rs**

修改 `src-tauri/src/lib.rs`，在 `invoke_handler!` 宏中追加新命令：

```rust
mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::file::read_file,
            commands::file::write_file,
            commands::file::write_files_to_folder,
            commands::file::segment_file,
            commands::file::file_size,
            commands::file::merge_file,
            commands::file::split_file,
            commands::file::extract_by_tables,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: 编译 Rust，确认无报错**

```bash
cd src-tauri && cargo build 2>&1 | grep -E "^error" | head -20
```

期望：无 `error` 行输出（warning 可忽略）。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/file.rs src-tauri/src/lib.rs
git commit -m "feat: add Rust extract_by_tables command with streaming filter"
```

---

## Task 5: Rust 命令 — export_to_csv_file

**Files:**
- Modify: `src-tauri/src/commands/file.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: 在 file.rs 末尾（extract_by_tables 之后）追加 export_to_csv_file**

```rust
// ─── streaming CSV export ──────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ExportStats {
    pub table_count: usize,
    pub row_count: usize,
}

/// Export all INSERT statements from a large SQL file to per-table CSV files.
/// Streaming: O(one statement) memory regardless of file size.
#[tauri::command]
pub async fn export_to_csv_file(
    app: tauri::AppHandle,
    input_path: String,
    output_folder: String,
) -> Result<ExportStats, String> {
    let total_bytes = fs::metadata(&input_path).map(|m| m.len()).unwrap_or(0);
    let file = File::open(&input_path).map_err(|e| format!("无法打开文件: {}", e))?;
    let reader = BufReader::new(file);

    let mut table_writers: HashMap<String, BufWriter<File>> = HashMap::new();
    let mut table_has_header: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    let mut stmt_buf = String::new();
    let mut bytes_read: u64 = 0;
    let mut last_percent: u8 = 0;
    let mut row_count: usize = 0;

    // Explicit-parameter closure avoids mutable-capture borrow issues (same pattern as merge_file)
    let process_export = |stmt: &str,
                          table_writers: &mut HashMap<String, BufWriter<File>>,
                          table_has_header: &mut std::collections::HashSet<String>,
                          row_count: &mut usize,
                          output_folder: &str|
     -> Result<(), String> {
        let h = match parse_insert_header(stmt) {
            Some(h) => h,
            None => return Ok(()),
        };
        let tname = normalize_table_name(&h.table_expr);

        if !table_writers.contains_key(&tname) {
            let csv_path = Path::new(output_folder).join(format!("{}.csv", tname));
            let f = File::create(&csv_path)
                .map_err(|e| format!("创建 {}.csv 失败: {}", tname, e))?;
            table_writers.insert(tname.clone(), BufWriter::new(f));
        }

        let writer = table_writers.get_mut(&tname).unwrap();

        if !table_has_header.contains(&tname) && !h.columns.is_empty() {
            let cols_inner = h.columns.trim_start_matches('(').trim_end_matches(')');
            let header: Vec<String> = cols_inner
                .split(',')
                .map(|c| c.trim().trim_matches('`').to_string())
                .collect();
            let header_line = header
                .iter()
                .map(|c| csv_escape(c.as_str()))
                .collect::<Vec<_>>()
                .join(",");
            writer.write_all(header_line.as_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(b"\r\n").map_err(|e| e.to_string())?;
            table_has_header.insert(tname.clone());
        }

        let vals_bytes = stmt.as_bytes();
        if let Some(vals_slice) = vals_bytes.get(h.values_offset..) {
            let vals_slice = {
                let mut end = vals_slice.len();
                while end > 0
                    && matches!(vals_slice[end - 1], b';' | b' ' | b'\t' | b'\r' | b'\n')
                {
                    end -= 1;
                }
                &vals_slice[..end]
            };
            for tuple in split_value_tuples(vals_slice) {
                let csv_row = tuple_to_csv_row(tuple);
                writer.write_all(csv_row.as_bytes()).map_err(|e| e.to_string())?;
                writer.write_all(b"\r\n").map_err(|e| e.to_string())?;
                *row_count += 1;
            }
        }
        Ok(())
    };

    for line_result in reader.lines() {
        let line = line_result.map_err(|e| e.to_string())?;
        bytes_read += line.len() as u64 + 1;
        emit_progress(&app, bytes_read, total_bytes, &mut last_percent);
        stmt_buf.push_str(&line);
        stmt_buf.push('\n');

        if line.trim_end().ends_with(';') {
            let stmt = stmt_buf.trim().to_string();
            stmt_buf.clear();
            if !stmt.is_empty() {
                process_export(
                    &stmt,
                    &mut table_writers,
                    &mut table_has_header,
                    &mut row_count,
                    &output_folder,
                )?;
            }
        }
    }
    let remaining = stmt_buf.trim().to_string();
    if !remaining.is_empty() {
        process_export(
            &remaining,
            &mut table_writers,
            &mut table_has_header,
            &mut row_count,
            &output_folder,
        )?;
    }

    // Flush all open writers
    for (_, mut w) in table_writers {
        w.flush().map_err(|e| e.to_string())?;
    }

    Ok(ExportStats {
        table_count: table_has_header.len(),
        row_count,
    })
}
```

- [ ] **Step 2: 注册 export_to_csv_file 到 lib.rs**

```rust
mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::file::read_file,
            commands::file::write_file,
            commands::file::write_files_to_folder,
            commands::file::segment_file,
            commands::file::file_size,
            commands::file::merge_file,
            commands::file::split_file,
            commands::file::extract_by_tables,
            commands::file::export_to_csv_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: 编译 Rust，确认无报错**

```bash
cd src-tauri && cargo build 2>&1 | grep -E "^error" | head -20
```

期望：无 `error` 行。

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/file.rs src-tauri/src/lib.rs
git commit -m "feat: add Rust export_to_csv_file command for large-file CSV export"
```

---

## Task 6: Convert.tsx — Tab 壳 + Tab 1 按表名抽取 UI

**Files:**
- Modify: `src/pages/Convert.tsx`

- [ ] **Step 1: 实现完整 Convert.tsx**

用以下内容完整替换 `src/pages/Convert.tsx`：

```tsx
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { StepFlow } from "@/components/StepFlow";
import { SqlEditor, type LargeFileInfo } from "@/components/SqlEditor";
import { ResultPanel } from "@/components/ResultPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CheckCircle, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { scanTables, extractTables } from "@/lib/sql/extract";
import {
  parseInsertToRows,
  toCsv,
  toCsvZip,
  toXlsx,
  downloadBlob,
} from "@/lib/sql/export";
import { useStreamProgress } from "@/hooks/useStreamProgress";
import { ProgressBar } from "@/components/ProgressBar";

// ─── Tab shell ─────────────────────────────────────────────────────────────

type TabId = "extract" | "export";
const TABS: { id: TabId; label: string }[] = [
  { id: "extract", label: "按表名抽取" },
  { id: "export", label: "SQL → CSV/Excel" },
];

export function Convert() {
  const [tab, setTab] = useState<TabId>("extract");

  return (
    <div className="flex flex-col p-6 max-w-3xl w-full gap-5">
      {/* Tab switcher */}
      <div className="flex gap-1 bg-muted rounded-lg p-1 w-fit">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={cn(
              "px-4 py-1.5 text-sm font-medium rounded-md transition-all",
              tab === id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "extract" ? <ExtractFlow /> : <ExportFlow />}
    </div>
  );
}

// ─── Tab 1: 按表名抽取 ─────────────────────────────────────────────────────

interface TableScan {
  name: string;
  count: number;
}

function ExtractFlow() {
  const [input, setInput] = useState("");
  const [largeFile, setLargeFile] = useState<LargeFileInfo | null>(null);
  const [scanned, setScanned] = useState(false);
  const [tables, setTables] = useState<TableScan[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [manualInput, setManualInput] = useState("");
  const [result, setResult] = useState<{ sql: string; meta: string } | null>(null);
  const [largeResult, setLargeResult] = useState<{
    matchedTables: number;
    statementCount: number;
    outputPath: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const { progress, startProgress } = useStreamProgress();
  const hasInput = !!input.trim() || !!largeFile;

  function resetResults() {
    setResult(null);
    setLargeResult(null);
    setError(null);
    setScanned(false);
    setTables([]);
    setSelected(new Set());
  }

  function handleScan() {
    const found = scanTables(input);
    setTables(found);
    setSelected(new Set(found.map((t) => t.name)));
    setScanned(true);
  }

  function toggleTable(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  function toggleAll(v: boolean) {
    setSelected(v ? new Set(tables.map((t) => t.name)) : new Set());
  }

  async function handleExecute() {
    setError(null);
    setResult(null);
    setLargeResult(null);

    if (largeFile) {
      const names = manualInput
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (names.length === 0) {
        setError("请输入至少一个表名");
        return;
      }
      const outputPath = await save({
        filters: [{ name: "SQL Files", extensions: ["sql"] }],
        defaultPath: "extracted.sql",
      });
      if (!outputPath) return;

      setProcessing(true);
      const stopProgress = await startProgress();
      try {
        const stats = await invoke<{ matched_tables: number; statement_count: number }>(
          "extract_by_tables",
          { inputPath: largeFile.path, outputPath, tables: names }
        );
        if (stats.statement_count === 0) {
          setError("未找到指定表名，请检查输入");
          return;
        }
        setLargeResult({
          matchedTables: stats.matched_tables,
          statementCount: stats.statement_count,
          outputPath,
        });
      } catch (e) {
        setError(`处理失败: ${e}`);
      } finally {
        stopProgress();
        setProcessing(false);
      }
      return;
    }

    // Small file
    setProcessing(true);
    await new Promise((r) => setTimeout(r, 0));
    try {
      const selectedNames = Array.from(selected);
      if (selectedNames.length === 0) {
        setError("请至少选择一张表");
        return;
      }
      const sql = extractTables(input, selectedNames);
      if (!sql) {
        setError("未找到指定表名，请检查输入");
        return;
      }
      const stmtCount = sql
        .split("\n")
        .filter((l) => l.trimEnd().endsWith(";")).length;
      setResult({
        sql,
        meta: `已抽取 ${selectedNames.length} 张表，共 ${stmtCount} 条语句`,
      });
    } catch (e) {
      setError(`处理失败: ${e}`);
    } finally {
      setProcessing(false);
    }
  }

  return (
    <StepFlow
      steps={[
        {
          number: 1,
          label: "输入 SQL",
          children: (
            <SqlEditor
              value={input}
              onChange={(v) => { setInput(v); resetResults(); }}
              largeFile={largeFile}
              onLargeFile={(f) => { setLargeFile(f); resetResults(); }}
              placeholder="粘贴包含多张表 INSERT 语句的 SQL，或拖拽 .sql / .txt 文件..."
            />
          ),
        },
        {
          number: 2,
          label: "选择表名",
          children: (
            <div className="space-y-3">
              {largeFile ? (
                /* Large file: manual input */
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    大文件模式：请手动输入要抽取的表名（逗号分隔）
                  </p>
                  <Input
                    value={manualInput}
                    onChange={(e) => setManualInput(e.target.value)}
                    placeholder="user_info, order_detail, product"
                    className="font-mono text-sm"
                  />
                </div>
              ) : (
                /* Small file: scan + checkbox list */
                <div className="space-y-2">
                  {!scanned ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleScan}
                      disabled={!hasInput}
                    >
                      扫描表名
                    </Button>
                  ) : tables.length === 0 ? (
                    <p className="text-xs text-destructive">未识别到 INSERT 语句</p>
                  ) : (
                    <div className="space-y-1.5">
                      <div className="flex gap-3 text-xs text-muted-foreground">
                        <button onClick={() => toggleAll(true)} className="hover:text-foreground">全选</button>
                        <button onClick={() => toggleAll(false)} className="hover:text-foreground">全不选</button>
                        <span>{selected.size} / {tables.length} 张表已选</span>
                      </div>
                      <div className="max-h-40 overflow-y-auto space-y-1 pr-1">
                        {tables.map(({ name, count }) => (
                          <label
                            key={name}
                            className="flex items-center gap-2 text-sm cursor-pointer"
                          >
                            <input
                              type="checkbox"
                              checked={selected.has(name)}
                              onChange={() => toggleTable(name)}
                              className="accent-indigo-500"
                            />
                            <span className="font-mono">{name}</span>
                            <span className="text-xs text-muted-foreground">
                              {count.toLocaleString()} 条
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center gap-3 flex-wrap">
                <Button
                  onClick={handleExecute}
                  disabled={!hasInput || processing}
                  className="bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white shadow-md shadow-indigo-500/20"
                >
                  {processing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                  {processing
                    ? "处理中..."
                    : largeFile
                    ? "选择保存位置并执行"
                    : "执行抽取"}
                </Button>
                {error && <p className="text-xs text-destructive">{error}</p>}
                {progress !== null && largeFile && <ProgressBar percent={progress} />}
              </div>
            </div>
          ),
        },
        {
          number: 3,
          label: "查看结果",
          children: largeResult ? (
            <div className="flex items-start gap-3 p-4 rounded-lg bg-green-500/10 border border-green-500/20">
              <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <p className="text-sm font-medium">抽取完成</p>
                <p className="text-xs text-muted-foreground">
                  共匹配 {largeResult.matchedTables} 张表，{largeResult.statementCount} 条语句
                </p>
                <p className="text-xs text-muted-foreground font-mono break-all">
                  {largeResult.outputPath}
                </p>
              </div>
            </div>
          ) : result ? (
            <ResultPanel content={result.sql} meta={result.meta} />
          ) : (
            <p className="text-sm text-muted-foreground">执行后结果将显示在这里...</p>
          ),
        },
      ]}
    />
  );
}

// ─── Tab 2: SQL → CSV/Excel ────────────────────────────────────────────────

function ExportFlow() {
  const [input, setInput] = useState("");
  const [largeFile, setLargeFile] = useState<LargeFileInfo | null>(null);
  const [format, setFormat] = useState<"csv" | "xlsx">("csv");
  const [status, setStatus] = useState<{
    tableCount: number;
    rowCount: number;
    message: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const { progress, startProgress } = useStreamProgress();
  const hasInput = !!input.trim() || !!largeFile;
  const formatDowngraded = !!largeFile && format === "xlsx";
  const effectiveFormat = formatDowngraded ? "csv" : format;

  async function handleExecute() {
    setError(null);
    setStatus(null);

    if (largeFile) {
      const folderPath = await open({ directory: true, title: "选择输出文件夹" });
      if (!folderPath || typeof folderPath !== "string") return;

      setProcessing(true);
      const stopProgress = await startProgress();
      try {
        const stats = await invoke<{ table_count: number; row_count: number }>(
          "export_to_csv_file",
          { inputPath: largeFile.path, outputFolder: folderPath }
        );
        setStatus({
          tableCount: stats.table_count,
          rowCount: stats.row_count,
          message: folderPath,
        });
      } catch (e) {
        setError(`处理失败: ${e}`);
      } finally {
        stopProgress();
        setProcessing(false);
      }
      return;
    }

    // Small file
    setProcessing(true);
    await new Promise((r) => setTimeout(r, 0));
    try {
      const tables = parseInsertToRows(input);
      if (tables.length === 0) {
        setError("未识别到有效的 INSERT 语句");
        return;
      }
      const totalRows = tables.reduce((sum, t) => sum + t.rows.length, 0);

      if (effectiveFormat === "xlsx") {
        const blob = toXlsx(tables);
        downloadBlob(blob, "export.xlsx");
        setStatus({ tableCount: tables.length, rowCount: totalRows, message: "export.xlsx 已下载" });
      } else if (tables.length === 1) {
        const blob = new Blob([toCsv(tables[0])], { type: "text/csv;charset=utf-8" });
        downloadBlob(blob, `${tables[0].tableName}.csv`);
        setStatus({ tableCount: 1, rowCount: totalRows, message: `${tables[0].tableName}.csv 已下载` });
      } else {
        const blob = await toCsvZip(tables);
        downloadBlob(blob, "export.zip");
        setStatus({ tableCount: tables.length, rowCount: totalRows, message: "export.zip 已下载" });
      }
    } catch (e) {
      setError(`处理失败: ${e}`);
    } finally {
      setProcessing(false);
    }
  }

  return (
    <StepFlow
      steps={[
        {
          number: 1,
          label: "输入 SQL",
          children: (
            <SqlEditor
              value={input}
              onChange={(v) => { setInput(v); setStatus(null); setError(null); }}
              largeFile={largeFile}
              onLargeFile={(f) => { setLargeFile(f); setStatus(null); setError(null); }}
              placeholder="粘贴包含 INSERT 语句的 SQL，或拖拽 .sql / .txt 文件..."
            />
          ),
        },
        {
          number: 2,
          label: "配置导出",
          children: (
            <div className="flex items-center gap-3 flex-wrap">
              <Label className="text-sm whitespace-nowrap">输出格式</Label>
              <Select
                value={format}
                onValueChange={(v) => setFormat(v as "csv" | "xlsx")}
              >
                <SelectTrigger className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="csv">CSV</SelectItem>
                  <SelectItem value="xlsx">Excel (.xlsx)</SelectItem>
                </SelectContent>
              </Select>
              {formatDowngraded && (
                <p className="text-xs text-amber-500">
                  大文件不支持 Excel，将以 CSV 导出
                </p>
              )}
              <Button
                onClick={handleExecute}
                disabled={!hasInput || processing}
                className="bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white shadow-md shadow-indigo-500/20"
              >
                {processing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                {processing
                  ? "处理中..."
                  : largeFile
                  ? "选择输出文件夹并导出"
                  : "导出"}
              </Button>
              {error && <p className="text-xs text-destructive">{error}</p>}
              {progress !== null && largeFile && <ProgressBar percent={progress} />}
            </div>
          ),
        },
        {
          number: 3,
          label: "导出结果",
          children: status ? (
            <div className="flex items-start gap-3 p-4 rounded-lg bg-green-500/10 border border-green-500/20">
              <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <p className="text-sm font-medium">导出完成</p>
                <p className="text-xs text-muted-foreground">
                  共 {status.tableCount} 张表，{status.rowCount.toLocaleString()} 行数据
                </p>
                <p className="text-xs text-muted-foreground font-mono break-all">
                  {status.message}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">导出后结果将显示在这里...</p>
          ),
        },
      ]}
    />
  );
}
```

- [ ] **Step 2: 验证 TypeScript 编译**

```bash
npx tsc --noEmit 2>&1 | head -30
```

期望：无报错输出。

- [ ] **Step 3: Commit**

```bash
git add src/pages/Convert.tsx
git commit -m "feat: Convert page with extract and export tabs"
```

---

## Task 7: 全量测试 + 验收

- [ ] **Step 1: 跑全部前端单元测试**

```bash
npx vitest run 2>&1 | tail -20
```

期望：所有测试通过，无失败项。

- [ ] **Step 2: 运行开发模式验收（手动）**

```bash
npm run tauri dev
```

按以下场景逐一验证：

**Tab 1 — 按表名抽取（小文件）**
1. 粘贴包含两张表的 SQL（如 `users` + `orders` 各若干条 INSERT）
2. 点「扫描表名」→ 确认 checkbox 列表出现，行数正确
3. 只勾选 `users` → 点「执行抽取」
4. 结果只含 `users` 的 INSERT；meta 显示正确数字

**Tab 1 — 按表名抽取（大文件）**
1. 拖拽 >10MB 的 SQL 文件
2. 步骤 2 变为文本输入框，输入表名
3. 点执行 → 弹出保存对话框 → 检查输出文件内容

**Tab 2 — SQL→CSV 导出（单表小文件）**
1. 粘贴含单张表的 SQL
2. 格式选 CSV → 点导出
3. 浏览器下载 `{tableName}.csv`，用 Excel 打开验证列名和数据

**Tab 2 — SQL→CSV/zip 导出（多表小文件）**
1. 粘贴含两张表的 SQL
2. 格式选 CSV → 点导出
3. 浏览器下载 `export.zip`，解压验证两个 CSV 文件

**Tab 2 — SQL→xlsx 导出（小文件）**
1. 粘贴含两张表的 SQL
2. 格式选 Excel → 点导出
3. 下载 `export.xlsx`，用 Excel 打开验证两个 Sheet

**Tab 2 — 大文件 Excel 自动降级**
1. 拖拽 >10MB 文件，格式选 Excel
2. 确认出现「大文件不支持 Excel，将以 CSV 导出」提示

**Tab 2 — SQL→CSV 大文件**
1. 拖拽 >10MB 文件，格式选 CSV → 点「选择输出文件夹并导出」
2. 确认输出文件夹中每张表生成一个 .csv 文件

- [ ] **Step 3: Commit 最终状态**

```bash
git add -A
git commit -m "feat: Sprint 1 complete — Convert page (extract by table + SQL→CSV/Excel)"
```

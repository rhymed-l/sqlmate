# Convert Restructure + CSV/Excel→SQL Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix design error — move 按表名抽取 to its own page, then add CSV/Excel→SQL as the second tab in 转换.

**Architecture:** Four tasks in dependency order: (1) JS import.ts layer, (2) Extract.tsx standalone page + routing, (3) Convert.tsx restructure (replace extract tab with CSV/Excel→SQL ImportFlow), (4) three new Rust commands + calamine for large-file processing. Small CSV (≤10MB) is handled entirely in JS; all Excel (any size) and large CSV go through Rust and save to a .sql file.

**Tech Stack:** React 19, TypeScript, Tauri 2, Rust, calamine 0.24 (Rust Excel reader), existing xlsx/jszip (already installed), tauri-plugin-dialog (open/save already used), vitest.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/lib/sql/import.ts` | Create | `csvToSql()` — small CSV text → SQL string |
| `src/lib/sql/import.test.ts` | Create | Unit tests for csvToSql |
| `src/pages/Extract.tsx` | Create | Standalone 按表名抽取 page (ExtractFlow moved from Convert.tsx) |
| `src/components/Sidebar.tsx` | Modify | Add `{ id: "extract", label: "抽取", Icon: Filter }` |
| `src/App.tsx` | Modify | Add `"extract"` to PageId, import + register Extract |
| `src/pages/Convert.tsx` | Modify | Remove ExtractFlow; update tabs to "SQL→CSV/Excel" \| "CSV/Excel→SQL"; add ImportFlow |
| `src-tauri/Cargo.toml` | Modify | Add `calamine = "0.24"` |
| `src-tauri/src/commands/file.rs` | Modify | Add `get_excel_sheets`, `import_csv_to_sql`, `import_excel_to_sql`, `parse_csv_line` helper |
| `src-tauri/src/lib.rs` | Modify | Register three new commands |

---

## Task 1: import.ts — csvToSql + unit tests

**Files:**
- Create: `src/lib/sql/import.ts`
- Create: `src/lib/sql/import.test.ts`

Only small CSV (≤10MB) is handled in JS. Excel always goes through Rust (calamine), so no `getExcelSheets` or `excelToSql` in JS.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/sql/import.test.ts`:

```typescript
// @vitest-environment node
import { describe, it, expect } from "vitest";
import { csvToSql } from "./import";

describe("csvToSql", () => {
  it("generates INSERT statements with column list from header row", () => {
    const csv = "name,age\nAlice,30\nBob,25";
    const sql = csvToSql(csv, "users");
    const lines = sql.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "INSERT INTO `users` (`name`, `age`) VALUES ('Alice', '30');"
    );
    expect(lines[1]).toBe(
      "INSERT INTO `users` (`name`, `age`) VALUES ('Bob', '25');"
    );
  });

  it("maps empty cell to NULL", () => {
    const csv = "name,age\nAlice,";
    const sql = csvToSql(csv, "users");
    expect(sql).toBe(
      "INSERT INTO `users` (`name`, `age`) VALUES ('Alice', NULL);"
    );
  });

  it("escapes single quotes in values", () => {
    const csv = "note\nit's a test";
    const sql = csvToSql(csv, "notes");
    expect(sql).toContain("'it''s a test'");
  });

  it("handles quoted fields with embedded commas", () => {
    const csv = 'city,desc\nNYC,"Big, Apple"';
    const sql = csvToSql(csv, "places");
    expect(sql).toContain("('NYC', 'Big, Apple')");
  });

  it("handles quoted fields with double-quote escaping (RFC 4180)", () => {
    const csv = 'note\n"say ""hello"""';
    const sql = csvToSql(csv, "t");
    expect(sql).toContain(`'say "hello"'`);
  });

  it("returns empty string when csv has fewer than 2 rows", () => {
    expect(csvToSql("name,age", "users")).toBe("");
    expect(csvToSql("", "users")).toBe("");
  });

  it("handles CRLF line endings", () => {
    const csv = "name,age\r\nAlice,30\r\nBob,25";
    const sql = csvToSql(csv, "users");
    expect(sql.split("\n")).toHaveLength(2);
  });

  it("skips blank rows", () => {
    const csv = "name\nAlice\n\nBob";
    const sql = csvToSql(csv, "t");
    expect(sql.split("\n")).toHaveLength(2);
  });

  it("strips backtick characters from column headers", () => {
    const csv = "`name`,`age`\nAlice,30";
    const sql = csvToSql(csv, "users");
    // backticks in header stripped then re-added: `name`, `age`
    expect(sql).toContain("(`name`, `age`)");
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

```
npx vitest run src/lib/sql/import.test.ts 2>&1
```

Expected: FAIL with "Cannot find module './import'"

- [ ] **Step 3: Implement import.ts**

Create `src/lib/sql/import.ts`:

```typescript
/**
 * Parse a single CSV row per RFC 4180.
 * Handles quoted fields (embedded commas, double-quote escaping "").
 * Does NOT handle multi-line quoted fields (splits are done on \n first).
 */
function parseCsvRow(row: string): string[] {
  const fields: string[] = [];
  let i = 0;

  while (i <= row.length) {
    if (i === row.length) break;

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
      if (row[i] === ",") i++; // skip comma after closing quote
    } else {
      // Unquoted field
      const commaIdx = row.indexOf(",", i);
      if (commaIdx === -1) {
        fields.push(row.slice(i));
        break;
      } else {
        fields.push(row.slice(i, commaIdx));
        i = commaIdx + 1;
      }
    }
  }

  // Trailing comma means a final empty field
  if (row.endsWith(",")) fields.push("");

  return fields;
}

/**
 * Convert CSV text to SQL INSERT statements.
 * - First row is treated as column headers.
 * - Empty cells become NULL; all other values become single-quoted strings.
 * - Single quotes in values are escaped as ''.
 */
export function csvToSql(csvText: string, tableName: string): string {
  const lines = csvText.split(/\r?\n/);

  // Remove trailing blank lines
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
    lines.pop();
  }

  if (lines.length < 2) return "";

  const headers = parseCsvRow(lines[0]);
  const colList = headers
    .map((h) => `\`${h.replace(/`/g, "")}\``)
    .join(", ");

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

    stmts.push(`INSERT INTO \`${tableName}\` (${colList}) VALUES (${valList});`);
  }

  return stmts.join("\n");
}
```

- [ ] **Step 4: Run tests to confirm they pass**

```
npx vitest run src/lib/sql/import.test.ts 2>&1
```

Expected: 9/9 PASS

- [ ] **Step 5: Run full test suite to confirm no regressions**

```
npx vitest run 2>&1 | tail -10
```

Expected: all tests pass (was 39 before this task; now 48)

- [ ] **Step 6: Commit**

```bash
git add src/lib/sql/import.ts src/lib/sql/import.test.ts
git commit -m "feat: add import.ts — csvToSql with 9 unit tests"
```

---

## Task 2: Extract.tsx standalone page + routing

**Files:**
- Create: `src/pages/Extract.tsx`
- Modify: `src/components/Sidebar.tsx`
- Modify: `src/App.tsx`

The content of Extract.tsx is identical to the `ExtractFlow` function currently inside Convert.tsx, promoted to a full page with a wrapper div. Do NOT modify Convert.tsx yet — that is Task 3.

- [ ] **Step 1: Create Extract.tsx**

Create `src/pages/Extract.tsx` with the complete code below. This is a direct promotion of the `ExtractFlow` component from `src/pages/Convert.tsx` — verify the logic matches exactly:

```typescript
import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { StepFlow } from "@/components/StepFlow";
import { SqlEditor, type LargeFileInfo } from "@/components/SqlEditor";
import { ResultPanel } from "@/components/ResultPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle, Loader2 } from "lucide-react";
import { scanTables, extractTables } from "@/lib/sql/extract";
import { useStreamProgress } from "@/hooks/useStreamProgress";
import { ProgressBar } from "@/components/ProgressBar";

interface TableScan {
  name: string;
  count: number;
}

export function Extract() {
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
    <div className="flex flex-col p-6 max-w-3xl w-full gap-5">
      <StepFlow
        steps={[
          {
            number: 1,
            label: "输入 SQL",
            children: (
              <SqlEditor
                value={input}
                onChange={(v) => {
                  setInput(v);
                  resetResults();
                }}
                largeFile={largeFile}
                onLargeFile={(f) => {
                  setLargeFile(f);
                  resetResults();
                }}
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
                          <button
                            onClick={() => toggleAll(true)}
                            className="hover:text-foreground"
                          >
                            全选
                          </button>
                          <button
                            onClick={() => toggleAll(false)}
                            className="hover:text-foreground"
                          >
                            全不选
                          </button>
                          <span>
                            {selected.size} / {tables.length} 张表已选
                          </span>
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
                                {count.toLocaleString()} 条语句
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
                    {processing && (
                      <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    )}
                    {processing
                      ? "处理中..."
                      : largeFile
                      ? "选择保存位置并执行"
                      : "执行抽取"}
                  </Button>
                  {error && (
                    <p className="text-xs text-destructive">{error}</p>
                  )}
                  {progress !== null && largeFile && (
                    <ProgressBar percent={progress} />
                  )}
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
                    共匹配 {largeResult.matchedTables} 张表，
                    {largeResult.statementCount} 条语句
                  </p>
                  <p className="text-xs text-muted-foreground font-mono break-all">
                    {largeResult.outputPath}
                  </p>
                </div>
              </div>
            ) : result ? (
              <ResultPanel content={result.sql} meta={result.meta} />
            ) : (
              <p className="text-sm text-muted-foreground">
                执行后结果将显示在这里...
              </p>
            ),
          },
        ]}
      />
    </div>
  );
}
```

- [ ] **Step 2: Add "抽取" nav item to Sidebar.tsx**

Current `src/components/Sidebar.tsx` line 1:
```typescript
import { GitMerge, Scissors, Files, Sparkles, ArrowLeftRight, Sun, Moon } from "lucide-react";
```

Replace with:
```typescript
import { GitMerge, Scissors, Files, Sparkles, ArrowLeftRight, Filter, Sun, Moon } from "lucide-react";
```

Current NAV_ITEMS (lines 11–17):
```typescript
const NAV_ITEMS: NavItem[] = [
  { id: "merge", label: "合并", Icon: GitMerge },
  { id: "split", label: "拆分", Icon: Scissors },
  { id: "segment", label: "分割", Icon: Files },
  { id: "format", label: "格式化", Icon: Sparkles },
  { id: "convert", label: "转换", Icon: ArrowLeftRight },
];
```

Replace with (insert "抽取" between "格式化" and "转换"):
```typescript
const NAV_ITEMS: NavItem[] = [
  { id: "merge", label: "合并", Icon: GitMerge },
  { id: "split", label: "拆分", Icon: Scissors },
  { id: "segment", label: "分割", Icon: Files },
  { id: "format", label: "格式化", Icon: Sparkles },
  { id: "extract", label: "抽取", Icon: Filter },
  { id: "convert", label: "转换", Icon: ArrowLeftRight },
];
```

- [ ] **Step 3: Add "extract" route to App.tsx**

Current `src/App.tsx`:
```typescript
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
```

Replace with:
```typescript
import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { Merge } from "@/pages/Merge";
import { Split } from "@/pages/Split";
import { Segment } from "@/pages/Segment";
import { Format } from "@/pages/Format";
import { Extract } from "@/pages/Extract";
import { Convert } from "@/pages/Convert";

type PageId = "merge" | "split" | "segment" | "format" | "extract" | "convert";

const PAGES: Record<PageId, React.ComponentType> = {
  merge: Merge,
  split: Split,
  segment: Segment,
  format: Format,
  extract: Extract,
  convert: Convert,
};
```

- [ ] **Step 4: TypeScript check**

```
npx tsc --noEmit 2>&1
```

Expected: no output (zero errors)

- [ ] **Step 5: Commit**

```bash
git add src/pages/Extract.tsx src/components/Sidebar.tsx src/App.tsx
git commit -m "feat: Extract standalone page with Filter nav entry"
```

---

## Task 3: Convert.tsx restructure

**Files:**
- Modify: `src/pages/Convert.tsx`

Remove the `ExtractFlow` component and the "按表名抽取" tab entirely. Update the two tabs to `"export"` (SQL→CSV/Excel, already working) and `"import"` (CSV/Excel→SQL, new). Add the `ImportFlow` component.

**ImportFlow architecture:**
- User clicks "选择文件" → `open()` dialog with `.csv,.xlsx` filter → get path
- `file_size(path)` determines small (≤10MB) vs large
- If Excel: always call Rust `get_excel_sheets` → user fills table name per sheet → Rust `import_excel_to_sql` → success card
- If CSV small: `read_file(path)` → `csvToSql()` in JS → ResultPanel
- If CSV large: `import_csv_to_sql` Rust command → success card

- [ ] **Step 1: Replace Convert.tsx with the full restructured file**

Replace the entire contents of `src/pages/Convert.tsx` with:

```typescript
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
import {
  parseInsertToRows,
  toCsv,
  toCsvZip,
  toXlsx,
  downloadBlob,
} from "@/lib/sql/export";
import { csvToSql } from "@/lib/sql/import";
import { useStreamProgress } from "@/hooks/useStreamProgress";
import { ProgressBar } from "@/components/ProgressBar";

// ─── Tab shell ─────────────────────────────────────────────────────────────

type TabId = "export" | "import";
const TABS: { id: TabId; label: string }[] = [
  { id: "export", label: "SQL → CSV/Excel" },
  { id: "import", label: "CSV/Excel → SQL" },
];

export function Convert() {
  const [tab, setTab] = useState<TabId>("export");

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

      {tab === "export" ? <ExportFlow /> : <ImportFlow />}
    </div>
  );
}

// ─── Tab 1: SQL → CSV/Excel ────────────────────────────────────────────────

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
        const blob = await toXlsx(tables);
        downloadBlob(blob, "export.xlsx");
        setStatus({
          tableCount: tables.length,
          rowCount: totalRows,
          message: "export.xlsx 已下载",
        });
      } else if (tables.length === 1) {
        const blob = new Blob([toCsv(tables[0])], {
          type: "text/csv;charset=utf-8",
        });
        downloadBlob(blob, `${tables[0].tableName}.csv`);
        setStatus({
          tableCount: 1,
          rowCount: totalRows,
          message: `${tables[0].tableName}.csv 已下载`,
        });
      } else {
        const blob = await toCsvZip(tables);
        downloadBlob(blob, "export.zip");
        setStatus({
          tableCount: tables.length,
          rowCount: totalRows,
          message: "export.zip 已下载",
        });
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
              onChange={(v) => {
                setInput(v);
                setStatus(null);
                setError(null);
              }}
              largeFile={largeFile}
              onLargeFile={(f) => {
                setLargeFile(f);
                setStatus(null);
                setError(null);
              }}
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
                {processing && (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                )}
                {processing
                  ? "处理中..."
                  : largeFile
                  ? "选择输出文件夹并导出"
                  : "导出"}
              </Button>
              {error && <p className="text-xs text-destructive">{error}</p>}
              {progress !== null && largeFile && (
                <ProgressBar percent={progress} />
              )}
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
                  共 {status.tableCount} 张表，
                  {status.rowCount.toLocaleString()} 行数据
                </p>
                <p className="text-xs text-muted-foreground font-mono break-all">
                  {status.message}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              导出后结果将显示在这里...
            </p>
          ),
        },
      ]}
    />
  );
}

// ─── Tab 2: CSV/Excel → SQL ────────────────────────────────────────────────

interface SheetMap {
  sheetName: string;
  tableName: string;
}

function ImportFlow() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileType, setFileType] = useState<"csv" | "xlsx" | null>(null);
  const [isLarge, setIsLarge] = useState(false);
  // Excel only: sheet names fetched from Rust
  const [sheetMaps, setSheetMaps] = useState<SheetMap[]>([]);
  const [scanning, setScanning] = useState(false);
  // CSV only: single table name input
  const [csvTableName, setCsvTableName] = useState("");
  // Results
  const [smallResult, setSmallResult] = useState<string | null>(null);
  const [largeResult, setLargeResult] = useState<{
    rowCount: number;
    tableCount: number;
    outputPath: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const { progress, startProgress } = useStreamProgress();

  async function handleSelectFile() {
    const path = await open({
      filters: [{ name: "CSV / Excel", extensions: ["csv", "xlsx"] }],
      title: "选择文件",
    });
    if (!path || typeof path !== "string") return;

    // Reset state
    setFilePath(path);
    setSheetMaps([]);
    setCsvTableName("");
    setSmallResult(null);
    setLargeResult(null);
    setError(null);
    setScanning(false);

    const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
    setFileName(name);
    const ext = name.split(".").pop()?.toLowerCase();
    const type: "csv" | "xlsx" = ext === "xlsx" ? "xlsx" : "csv";
    setFileType(type);

    const size = await invoke<number>("file_size", { path });
    setIsLarge(size > 10 * 1024 * 1024);

    if (type === "xlsx") {
      setScanning(true);
      try {
        const sheets = await invoke<string[]>("get_excel_sheets", {
          inputPath: path,
        });
        setSheetMaps(sheets.map((s) => ({ sheetName: s, tableName: "" })));
      } catch (e) {
        setError(`无法读取 Sheet 名称: ${e}`);
      } finally {
        setScanning(false);
      }
    }
  }

  async function handleExecute() {
    if (!filePath || !fileType) return;
    setError(null);
    setSmallResult(null);
    setLargeResult(null);

    if (fileType === "csv") {
      const tname = csvTableName.trim();
      if (!tname) {
        setError("请输入表名");
        return;
      }

      if (!isLarge) {
        // Small CSV: read text → JS convert → ResultPanel
        setProcessing(true);
        await new Promise((r) => setTimeout(r, 0));
        try {
          const text = await invoke<string>("read_file", { path: filePath });
          const sql = csvToSql(text, tname);
          if (!sql) {
            setError("CSV 中没有数据行");
            return;
          }
          setSmallResult(sql);
        } catch (e) {
          setError(`处理失败: ${e}`);
        } finally {
          setProcessing(false);
        }
      } else {
        // Large CSV: Rust streaming
        const outputPath = await save({
          filters: [{ name: "SQL Files", extensions: ["sql"] }],
          defaultPath: `${tname}.sql`,
        });
        if (!outputPath) return;

        setProcessing(true);
        const stopProgress = await startProgress();
        try {
          const stats = await invoke<{ row_count: number; table_count: number }>(
            "import_csv_to_sql",
            { inputPath: filePath, outputPath, tableName: tname }
          );
          setLargeResult({
            rowCount: stats.row_count,
            tableCount: 1,
            outputPath,
          });
        } catch (e) {
          setError(`处理失败: ${e}`);
        } finally {
          stopProgress();
          setProcessing(false);
        }
      }
    } else {
      // Excel: always Rust (get_excel_sheets was already called on file select)
      if (sheetMaps.length === 0) {
        setError("无法读取 Sheet 信息，请重新选择文件");
        return;
      }
      if (sheetMaps.some((m) => !m.tableName.trim())) {
        setError("请为每个 Sheet 填写表名");
        return;
      }
      const outputPath = await save({
        filters: [{ name: "SQL Files", extensions: ["sql"] }],
        defaultPath: "import.sql",
      });
      if (!outputPath) return;

      setProcessing(true);
      const stopProgress = await startProgress();
      try {
        const stats = await invoke<{ row_count: number; table_count: number }>(
          "import_excel_to_sql",
          {
            inputPath: filePath,
            outputPath,
            sheetTableMaps: sheetMaps.map((m) => ({
              sheet_name: m.sheetName,
              table_name: m.tableName.trim(),
            })),
          }
        );
        setLargeResult({
          rowCount: stats.row_count,
          tableCount: stats.table_count,
          outputPath,
        });
      } catch (e) {
        setError(`处理失败: ${e}`);
      } finally {
        stopProgress();
        setProcessing(false);
      }
    }
  }

  const canExecute =
    !!filePath &&
    !processing &&
    !scanning &&
    (fileType === "csv"
      ? !!csvTableName.trim()
      : sheetMaps.length > 0 && sheetMaps.every((m) => !!m.tableName.trim()));

  return (
    <StepFlow
      steps={[
        {
          number: 1,
          label: "选择文件",
          children: (
            <div className="space-y-2">
              <Button
                variant="outline"
                onClick={handleSelectFile}
                disabled={scanning || processing}
              >
                {scanning ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                    读取 Sheet 中...
                  </>
                ) : (
                  "选择 CSV / Excel 文件"
                )}
              </Button>
              {fileName && (
                <p className="text-xs text-muted-foreground font-mono">
                  {fileName}
                  {isLarge ? "（大文件，将由 Rust 处理）" : ""}
                </p>
              )}
            </div>
          ),
        },
        {
          number: 2,
          label: "配置",
          children: filePath ? (
            <div className="space-y-3">
              {fileType === "csv" ? (
                <div className="flex items-center gap-2">
                  <Label className="text-sm whitespace-nowrap">表名</Label>
                  <Input
                    value={csvTableName}
                    onChange={(e) => setCsvTableName(e.target.value)}
                    placeholder="users"
                    className="w-48 font-mono text-sm"
                  />
                </div>
              ) : sheetMaps.length > 0 ? (
                <div className="space-y-2">
                  <p className="text-xs text-muted-foreground">
                    为每个 Sheet 填写对应的表名：
                  </p>
                  {sheetMaps.map((map, idx) => (
                    <div key={map.sheetName} className="flex items-center gap-2">
                      <span className="text-sm font-mono w-32 truncate text-muted-foreground">
                        {map.sheetName}
                      </span>
                      <span className="text-muted-foreground text-xs">→</span>
                      <Input
                        value={map.tableName}
                        onChange={(e) => {
                          const next = [...sheetMaps];
                          next[idx] = { ...next[idx], tableName: e.target.value };
                          setSheetMaps(next);
                        }}
                        placeholder={map.sheetName}
                        className="w-40 font-mono text-sm"
                      />
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="flex items-center gap-3 flex-wrap">
                <Button
                  onClick={handleExecute}
                  disabled={!canExecute}
                  className="bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white shadow-md shadow-indigo-500/20"
                >
                  {processing && (
                    <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                  )}
                  {processing
                    ? "处理中..."
                    : !isLarge && fileType === "csv"
                    ? "生成 SQL"
                    : "选择保存位置并执行"}
                </Button>
                {error && <p className="text-xs text-destructive">{error}</p>}
                {progress !== null && <ProgressBar percent={progress} />}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">先选择文件...</p>
          ),
        },
        {
          number: 3,
          label: "结果",
          children: largeResult ? (
            <div className="flex items-start gap-3 p-4 rounded-lg bg-green-500/10 border border-green-500/20">
              <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <p className="text-sm font-medium">转换完成</p>
                <p className="text-xs text-muted-foreground">
                  共 {largeResult.tableCount} 张表，
                  {largeResult.rowCount.toLocaleString()} 行数据
                </p>
                <p className="text-xs text-muted-foreground font-mono break-all">
                  {largeResult.outputPath}
                </p>
              </div>
            </div>
          ) : smallResult ? (
            <ResultPanel
              content={smallResult}
              meta={`CSV → SQL 转换完成`}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              执行后结果将显示在这里...
            </p>
          ),
        },
      ]}
    />
  );
}
```

- [ ] **Step 2: TypeScript check**

```
npx tsc --noEmit 2>&1
```

Expected: no output (zero errors)

- [ ] **Step 3: Confirm test suite still passes**

```
npx vitest run 2>&1 | tail -5
```

Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add src/pages/Convert.tsx
git commit -m "feat: Convert restructure — remove extract tab, add CSV/Excel→SQL import tab"
```

---

## Task 4: Rust — calamine + get_excel_sheets + import_csv_to_sql + import_excel_to_sql

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `src-tauri/src/commands/file.rs`
- Modify: `src-tauri/src/lib.rs`

Three new commands + one private helper function `parse_csv_line`. All added at the bottom of file.rs after the existing `export_to_csv_file` command.

**Dependency note:** calamine 0.24 uses `DataType` enum with variants `Empty`, `String`, `Float`, `Bool`, `Error`. `worksheet_range` returns `Option<Result<Range<DataType>>>`.

- [ ] **Step 1: Add calamine to Cargo.toml**

In `src-tauri/Cargo.toml`, in the `[dependencies]` section, add:

```toml
calamine = "0.24"
```

Full `[dependencies]` section after the edit:
```toml
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-opener = "2"
tauri-plugin-dialog = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
regex = "1"
calamine = "0.24"
```

- [ ] **Step 2: Verify cargo resolves (no compile yet)**

```bash
cd src-tauri && cargo fetch 2>&1 | tail -5
```

Expected: "Fetch [packages]" messages, exits 0

- [ ] **Step 3: Add calamine import + three commands + helper to file.rs**

At the very top of `src-tauri/src/commands/file.rs`, add the calamine import after the existing use statements:

```rust
use calamine::{open_workbook, DataType, Reader, Xlsx};
```

Full import block at the top of file.rs becomes:
```rust
use calamine::{open_workbook, DataType, Reader, Xlsx};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;
use tauri::Emitter;
```

Then append the following at the very end of `src-tauri/src/commands/file.rs` (after the closing brace of `export_to_csv_file`):

```rust
// ─── CSV line parser ───────────────────────────────────────────────────────

/// Parse a single CSV line per RFC 4180 (handles quoted fields with embedded
/// commas and "" double-quote escaping). Does not handle multi-line quoted
/// fields — call sites split on newlines first.
fn parse_csv_line(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let mut fields: Vec<String> = Vec::new();
    let mut i = 0usize;

    loop {
        if i > bytes.len() {
            break;
        }
        if i == bytes.len() {
            break;
        }
        if bytes[i] == b'"' {
            // Quoted field
            i += 1;
            let mut val: Vec<u8> = Vec::new();
            while i < bytes.len() {
                if bytes[i] == b'"' {
                    if i + 1 < bytes.len() && bytes[i + 1] == b'"' {
                        val.push(b'"');
                        i += 2;
                    } else {
                        i += 1; // skip closing quote
                        break;
                    }
                } else {
                    val.push(bytes[i]);
                    i += 1;
                }
            }
            fields.push(String::from_utf8_lossy(&val).to_string());
            if i < bytes.len() && bytes[i] == b',' {
                i += 1;
            }
        } else {
            // Unquoted field
            let start = i;
            while i < bytes.len() && bytes[i] != b',' {
                i += 1;
            }
            fields.push(String::from_utf8_lossy(&bytes[start..i]).to_string());
            if i < bytes.len() {
                i += 1; // skip comma
            } else {
                break;
            }
        }
    }

    // Trailing comma → trailing empty field
    if line.ends_with(',') {
        fields.push(String::new());
    }

    fields
}

// ─── Excel sheet scanner ───────────────────────────────────────────────────

/// Return the sheet names from an .xlsx file.
#[tauri::command]
pub async fn get_excel_sheets(input_path: String) -> Result<Vec<String>, String> {
    let wb: Xlsx<_> =
        open_workbook(&input_path).map_err(|e| format!("无法打开 Excel 文件: {}", e))?;
    Ok(wb.sheet_names().to_vec())
}

// ─── Excel → SQL ───────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct SheetTableMap {
    pub sheet_name: String,
    pub table_name: String,
}

#[derive(serde::Serialize)]
pub struct ImportStats {
    pub row_count: usize,
    pub table_count: usize,
}

/// Convert an .xlsx file to SQL INSERT statements.
/// Each sheet → one block of INSERTs. Row 1 is the header (column names).
/// Empty cells → NULL. All other values → single-quoted strings.
/// Progress is reported per sheet (not per row).
#[tauri::command]
pub async fn import_excel_to_sql(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    sheet_table_maps: Vec<SheetTableMap>,
) -> Result<ImportStats, String> {
    let mut wb: Xlsx<_> =
        open_workbook(&input_path).map_err(|e| format!("无法打开 Excel 文件: {}", e))?;
    let out =
        File::create(&output_path).map_err(|e| format!("创建输出文件失败: {}", e))?;
    let mut writer = BufWriter::new(out);
    let mut total_rows = 0usize;
    let total_sheets = sheet_table_maps.len();

    for (sheet_idx, map) in sheet_table_maps.iter().enumerate() {
        let range = match wb.worksheet_range(&map.sheet_name) {
            Some(Ok(r)) => r,
            Some(Err(e)) => {
                return Err(format!("读取 Sheet '{}' 失败: {}", map.sheet_name, e))
            }
            None => continue, // sheet not found — skip silently
        };

        let mut rows_iter = range.rows();

        // First row: headers
        let headers: Vec<String> = match rows_iter.next() {
            Some(row) => row
                .iter()
                .map(|c| c.to_string().replace('`', ""))
                .collect(),
            None => continue,
        };
        if headers.is_empty() {
            continue;
        }

        let col_list = headers
            .iter()
            .map(|h| format!("`{}`", h))
            .collect::<Vec<_>>()
            .join(", ");

        for row in rows_iter {
            // Skip completely empty rows
            if row.iter().all(|c| matches!(c, DataType::Empty)) {
                continue;
            }

            let val_list = (0..headers.len())
                .map(|i| match row.get(i) {
                    None | Some(DataType::Empty) => "NULL".to_string(),
                    Some(DataType::Error(_)) => "NULL".to_string(),
                    Some(v) => {
                        let s = v.to_string();
                        if s.is_empty() {
                            "NULL".to_string()
                        } else {
                            format!("'{}'", s.replace('\'', "''"))
                        }
                    }
                })
                .collect::<Vec<_>>()
                .join(", ");

            writeln!(
                writer,
                "INSERT INTO `{}` ({}) VALUES ({});",
                map.table_name, col_list, val_list
            )
            .map_err(|e| e.to_string())?;
            total_rows += 1;
        }

        // Progress: one tick per sheet
        let percent = ((sheet_idx + 1) as f64 / total_sheets as f64 * 100.0) as u8;
        app.emit("stream-progress", ProgressEvent { percent }).ok();
    }

    writer.flush().map_err(|e| e.to_string())?;

    Ok(ImportStats {
        row_count: total_rows,
        table_count: total_sheets,
    })
}

// ─── CSV → SQL (streaming) ─────────────────────────────────────────────────

/// Stream a large CSV file to SQL INSERT statements (O(1) memory).
/// First line is treated as column headers.
/// Empty fields → NULL. All others → single-quoted strings.
#[tauri::command]
pub async fn import_csv_to_sql(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    table_name: String,
) -> Result<ImportStats, String> {
    let total_bytes = fs::metadata(&input_path).map(|m| m.len()).unwrap_or(0);
    let file = File::open(&input_path).map_err(|e| format!("无法打开文件: {}", e))?;
    let reader = BufReader::new(file);
    let out =
        File::create(&output_path).map_err(|e| format!("创建输出文件失败: {}", e))?;
    let mut writer = BufWriter::new(out);

    let mut bytes_read: u64 = 0;
    let mut last_percent: u8 = 0;
    let mut row_count = 0usize;
    let mut headers: Option<Vec<String>> = None;
    let mut col_list = String::new();

    for line_result in reader.lines() {
        let raw = line_result.map_err(|e| e.to_string())?;
        bytes_read += raw.len() as u64 + 1;
        emit_progress(&app, bytes_read, total_bytes, &mut last_percent);

        // Strip trailing CR (handle CRLF files on any platform)
        let line = raw.trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }

        let fields = parse_csv_line(line);

        if headers.is_none() {
            // First non-empty line: treat as headers
            col_list = fields
                .iter()
                .map(|h| format!("`{}`", h.replace('`', "")))
                .collect::<Vec<_>>()
                .join(", ");
            headers = Some(fields);
            continue;
        }

        let hdr_count = headers.as_ref().unwrap().len();
        let val_list = (0..hdr_count)
            .map(|i| {
                let v = fields.get(i).map(|s| s.as_str()).unwrap_or("");
                if v.is_empty() {
                    "NULL".to_string()
                } else {
                    format!("'{}'", v.replace('\'', "''"))
                }
            })
            .collect::<Vec<_>>()
            .join(", ");

        writeln!(
            writer,
            "INSERT INTO `{}` ({}) VALUES ({});",
            table_name, col_list, val_list
        )
        .map_err(|e| e.to_string())?;
        row_count += 1;
    }

    writer.flush().map_err(|e| e.to_string())?;

    Ok(ImportStats {
        row_count,
        table_count: 1,
    })
}
```

- [ ] **Step 4: Register the three new commands in lib.rs**

Replace the invoke_handler block in `src-tauri/src/lib.rs`:

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
            commands::file::get_excel_sheets,
            commands::file::import_excel_to_sql,
            commands::file::import_csv_to_sql,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 5: Build to verify Rust compiles**

```bash
cd src-tauri && cargo build 2>&1 | grep -E "^error|Compiling sqlmate|Finished"
```

Expected output (no `error` lines):
```
   Compiling sqlmate v0.1.0 (...)
    Finished `dev` profile ...
```

If you see an error about calamine DataType variants, replace the specific variant name with `Some(v)` and use `v.to_string()` as the fallback (all DataType variants implement Display).

- [ ] **Step 6: Run full TypeScript check + tests**

```
npx tsc --noEmit 2>&1 && npx vitest run 2>&1 | tail -5
```

Expected: tsc produces no output; vitest: all tests pass

- [ ] **Step 7: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/src/commands/file.rs src-tauri/src/lib.rs
git commit -m "feat: Rust import commands — get_excel_sheets, import_excel_to_sql, import_csv_to_sql (calamine)"
```

---

## Self-Review

**Spec coverage check:**

| Requirement | Covered by |
|-------------|------------|
| 按表名抽取 as standalone page | Task 2 (Extract.tsx) |
| 抽取 nav entry in sidebar | Task 2 (Sidebar.tsx) |
| 转换 has two tabs: SQL→CSV/Excel and CSV/Excel→SQL | Task 3 (Convert.tsx) |
| Small CSV → SQL via JS (ResultPanel) | Task 1 + Task 3 |
| Large CSV → SQL via Rust streaming | Task 4 (import_csv_to_sql) |
| Excel: scan sheet names | Task 4 (get_excel_sheets) |
| Excel: user fills table name per sheet | Task 3 (ImportFlow UI) |
| Excel → SQL via Rust (any size) | Task 4 (import_excel_to_sql) |
| Single-quoted values; empty → NULL | Task 1 (csvToSql) + Task 4 |
| Progress bar for large files | Task 3 (uses existing useStreamProgress) |

**Placeholder scan:** None found — every step has complete code.

**Type consistency check:**
- `SheetTableMap` in Rust: fields `sheet_name` + `table_name` (snake_case) — matches frontend `invoke` call in Task 3 which passes `{ sheet_name: m.sheetName, table_name: m.tableName.trim() }` ✓
- `ImportStats` in Rust: fields `row_count` + `table_count` — matches frontend `invoke<{ row_count: number; table_count: number }>` ✓
- `get_excel_sheets` returns `Vec<String>` — matches `invoke<string[]>` ✓
- `csvToSql` in import.ts is imported directly in Convert.tsx (not via dynamic import) ✓

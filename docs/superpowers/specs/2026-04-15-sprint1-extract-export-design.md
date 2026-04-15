# Sprint 1 Design: 转换页（按表名抽取 + SQL→CSV/Excel 导出）

> Date: 2026-04-15 | Status: Approved | Related: REQ-002 F-01, F-03

## Overview

在 SQLMate 侧边栏新增一个「转换」入口，内含两个 Tab：
- **Tab 1：按表名抽取**（F-03）— 从 SQL 文件中过滤出指定表的 INSERT 语句
- **Tab 2：SQL → CSV/Excel**（F-01）— 把 INSERT 语句的数据导出为 CSV 或 xlsx

沿用现有架构：小文件（≤10MB）前端 JS 处理，大文件走 Rust 流式命令。

---

## 页面结构

### 路由 / 导航

- Sidebar 新增导航项：`id = "convert"`，`label = "转换"`，图标 `ArrowLeftRight`（lucide）
- 插入位置：「格式化」之后
- `App.tsx` 新增 case `"convert"` → `<Convert />`

### `src/pages/Convert.tsx`

顶部渲染两个 Tab 按钮（复用 shadcn/ui Tabs 或手写 className toggle，与整体风格一致）：

```
[ 按表名抽取 ]  [ SQL → CSV/Excel ]
─────────────────────────────────────
< 对应 StepFlow >
```

Tab 切换时重置当前 Tab 的状态（input、result 等），避免状态串联。

---

## Tab 1：按表名抽取

### 步骤流

**① 输入 SQL**
- `SqlEditor` 组件，支持粘贴 / 拖拽文件
- 大文件（>10MB）进入大文件模式，仅存路径

**② 配置抽取**

_小文件模式_：
- 用户点击「扫描表名」按钮，调用 `scanTables(sql)` 返回表名+行数列表
- 以 checkbox 列表展示，格式：`☑ user_info (1,234 行)`
- 提供「全选 / 全不选」快捷操作
- 用户勾选后点击「执行抽取」

_大文件模式_：
- 显示提示：「大文件模式：请手动输入要抽取的表名」
- 文本输入框，placeholder：`user_info, order_detail, product`（逗号分隔）
- 点击「选择保存位置并执行」→ 弹出文件保存对话框 → 调用 Rust 命令

**③ 结果**

- 小文件：`ResultPanel`（可复制 / 另存为）+ meta 信息（抽取了 N 张表，共 M 条语句）
- 大文件：成功卡片，显示输出文件路径 + 统计数

### JS 层：`src/lib/sql/extract.ts`

```typescript
/** 扫描所有表名及 INSERT 行数 */
export function scanTables(sql: string): { name: string; count: number }[]

/** 过滤出指定表的 INSERT 语句，保留原始格式 */
export function extractTables(sql: string, tables: string[]): string
```

实现要点：
- 表名规范化：去除 backtick、schema 前缀（`` `db`.`tbl` `` → `tbl`），大小写不敏感匹配
- 非 INSERT 语句（注释、SET、DDL）直接跳过，不输出

### Rust 命令：`extract_by_tables`

新增到 `src-tauri/src/commands/file.rs`：

```rust
#[tauri::command]
pub async fn extract_by_tables(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    tables: Vec<String>,   // 已规范化（小写，无 backtick）
) -> Result<ExtractStats, String>

pub struct ExtractStats {
    pub matched_tables: usize,
    pub statement_count: usize,
}
```

实现要点：
- 复用已有的 `parse_insert_header()` 提取表名
- 表名规范化逻辑与 JS 层一致（小写、去 backtick、去 schema 前缀）
- 未匹配到任何表时返回 `statement_count = 0`（不报错）
- 进度上报沿用 `stream-progress` 事件

---

## Tab 2：SQL → CSV/Excel 导出

### 步骤流

**① 输入 SQL**
- `SqlEditor`，同上

**② 配置导出**
- 输出格式选择：`CSV` / `Excel (.xlsx)`（Radio 或 Select）
- 大文件且选了 Excel → 自动切换为 CSV，显示内联提示：「Excel 不支持大文件（>10MB），已自动切换为 CSV」
- 点击执行按钮

**③ 结果**

_小文件 CSV_：
- 单表：触发浏览器下载 `{tableName}.csv`
- 多表：触发多次下载（每表一个文件）
- meta：共导出 N 张表，M 行数据

_小文件 Excel_：
- SheetJS 生成 .xlsx Blob，触发浏览器下载 `export.xlsx`
- 多表自动分 Sheet，Sheet 名 = 表名

_大文件（CSV only）_：
- 弹出文件夹选择对话框（`open({ directory: true })`）
- 调用 Rust 命令，每表输出一个 `{tableName}.csv` 到所选文件夹
- 成功卡片：显示文件夹路径 + 生成文件数

### JS 层：`src/lib/sql/export.ts`

```typescript
export interface TableData {
  tableName: string;
  columns: string[];
  rows: string[][];
}

/** 解析 SQL 中所有 INSERT 语句，返回结构化数据 */
export function parseInsertToRows(sql: string): TableData[]

/** 生成单表 CSV 字符串（RFC 4180，含列名行） */
export function toCsv(table: TableData): string

/** 生成多表 xlsx Blob（SheetJS），每表一个 Sheet */
export function toXlsx(tables: TableData[]): Blob
```

实现要点：
- 列名：优先从 `INSERT INTO tbl (col1, col2)` 提取；无列名则用 `col1, col2, ...`
- 值处理：去除字符串两端单引号；`NULL` → 空字符串
- CSV 转义：含逗号、换行、双引号的值用双引号包裹，内部双引号转 `""`
- `toXlsx` 依赖 `xlsx` 包（SheetJS），按需 import

### Rust 命令：`export_to_csv_file`

```rust
#[tauri::command]
pub async fn export_to_csv_file(
    app: tauri::AppHandle,
    input_path: String,
    output_folder: String,
) -> Result<ExportStats, String>

pub struct ExportStats {
    pub table_count: usize,
    pub row_count: usize,
}
```

实现要点：
- 流式解析：每遇到新表名，创建对应 `{tableName}.csv` 的 `BufWriter`
- 第一条该表语句时写列名行（从 INSERT 列名列表提取；无列名时跳过列名行）
- 每个 tuple 解析为 CSV 行，直接写盘，O(1) 内存
- 进度上报沿用 `stream-progress`

---

## 新增依赖

```bash
npm install xlsx
```

SheetJS (`xlsx`) 仅在 `toXlsx()` 路径中使用，其他路径不引入。

---

## 文件清单

| 文件 | 操作 |
|------|------|
| `src/pages/Convert.tsx` | 新建 |
| `src/lib/sql/extract.ts` | 新建 |
| `src/lib/sql/export.ts` | 新建 |
| `src-tauri/src/commands/file.rs` | 追加 `extract_by_tables` + `export_to_csv_file` |
| `src-tauri/src/lib.rs` | 注册新命令 |
| `src/components/Sidebar.tsx` | 新增 `convert` 导航项 |
| `src/App.tsx` | 新增 `convert` 路由 case |

---

## 边界情况与错误处理

| 情况 | 处理 |
|------|------|
| 输入 SQL 中没有 INSERT 语句 | 提示「未识别到有效的 INSERT 语句」 |
| 抽取时所有指定表名均未命中 | 提示「未找到指定表名，请检查输入」（不输出空文件） |
| 导出时 INSERT 无列名 | CSV 无列名行，用 `col1, col2...` 兜底 |
| Excel 大文件自动降级 | 内联警告，不阻断流程 |
| 多表 CSV 下载（小文件）| 逐个触发下载，浏览器可能拦截多次下载，提示用户允许 |

---

## 不在范围内（本次 Sprint）

- Tab 之间共享输入（每个 Tab 独立状态）
- 抽取同时保留 DDL（CREATE TABLE）语句
- Excel 大文件支持（明确限制，与 Format 页一致）
- 导出后自动打开文件夹

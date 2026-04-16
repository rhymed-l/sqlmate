# REQ-002: SQLMate v0.2 — 数据处理扩展功能集

> 创建时间: 2026-04-15 | 状态: 待实现 | 阶段: 需求规划

## 需求背景

SQLMate v0.1.0（REQ-001 v1.1）已完成核心 SQL 语句合并/拆分/分割/格式化功能。本需求描述下一阶段扩展功能，覆盖 DBA/开发者在数据处理工作中三个核心场景：

1. **格式互转**：SQL 与 CSV/Excel 之间的双向转换
2. **过滤提取**：从大文件中按条件精准提取数据
3. **数据治理**：去重、脱敏、表名替换、语句转换等修复操作

所有功能沿用 REQ-001 确立的技术架构：Tauri 2.0 + React 19 + Rust 流式大文件处理。

## 功能清单

### P0：高频刚需

#### F-01: SQL → CSV/Excel 导出

**场景**：把 INSERT 语句里的数据提取成表格，交给业务方或做进一步分析。

**业务规则**：
- 输入：包含 INSERT INTO 语句的 SQL 文本或文件
- 自动解析列名（从 INSERT INTO table (col1, col2) 语法提取）
- 若 INSERT 不含列名（仅 VALUES），则用 col1, col2, col3... 作为默认列名
- 支持多张表同时导出：每张表生成独立的 Sheet（Excel）或独立的 CSV 文件
- 输出格式：CSV（单文件/多文件）或 xlsx（多 Sheet）
- 小文件（≤10MB）：前端 JS 解析 + 前端生成文件
- 大文件（>10MB）：Rust 流式解析，输出到用户指定文件夹

**边界情况**：
- 跳过非 INSERT 语句（DDL、注释、空行）
- 字符串值去除两端单引号；NULL 值输出为空单元格
- 含逗号、换行的字段值需正确引用（CSV 规范）

---

#### F-02: CSV/Excel → SQL INSERT

**场景**：把表格数据转成 INSERT 语句，替代 Navicat 的同类功能，在本地离线完成。

**业务规则**：
- 输入：CSV 文件或 xlsx 文件（单 Sheet）
- 第一行默认为列名；支持勾选"无列名行"选项（使用 col1, col2...）
- 用户填写目标表名（必填）
- 用户选择输出模式：单条 INSERT / 批量 INSERT（可配置 batch_size，默认 1000）
- 数字类型值不加引号（自动检测：整列均为纯数字则视为数值型）
- NULL/空单元格输出为 NULL
- xlsx 支持多 Sheet：每个 Sheet 对应一张表，表名取 Sheet 名（可覆盖）

**边界情况**：
- 字符串中的单引号需转义为 ''
- 文件过大（>10MB）时 Rust 流式处理，输出到用户指定文件或文件夹

---

#### F-03: 按表名抽取

**场景**：一个大 dump 文件里有几十张表，只想要其中几张表的 INSERT 数据。

**业务规则**：
- 用户上传/粘贴 SQL 文件，工具先扫描列出所有表名及各表行数（预览阶段）
- 用户勾选想要的表名（多选）
- 输出：仅包含所选表的 INSERT 语句
- 输出时保留原文件中的注释行和 SET 语句（可选，默认保留）
- 大文件模式：Rust 两遍扫描（第一遍收集表名，第二遍按需过滤输出）
- 小文件模式：JS 一次性过滤

**边界情况**：
- 支持 INSERT INTO \`table\` 和 INSERT INTO table 两种写法
- 若所选表在文件中不存在，提示用户

---

### P1：中高频需求

#### F-04: 数据去重

**场景**：同一主键的行重复出现（多次导出合并导致），需按某列去重，保留最后一条（或第一条）。

**业务规则**：
- 用户指定去重列名（如 id）
- 冲突策略：保留第一条 / 保留最后一条（二选一，默认保留最后一条）
- 输出：去除重复后的 INSERT 语句集合
- 统计报告：原始行数、去重后行数、删除行数
- 大文件处理：Rust 读取 → 内存维护 HashMap<key, offset> → 两遍扫描（第一遍建索引，第二遍输出保留行）

**边界情况**：
- 去重列不存在时给出明确错误
- 若 INSERT 语句无列名，用户需手动指定第几列（1-based）

---

#### F-05: 数据脱敏

**场景**：手机号、身份证、邮箱替换成假数据，用于开发/测试环境，满足合规要求。

**业务规则**：
- 用户配置脱敏规则列表，每条规则包含：列名 + 脱敏类型
- 支持的脱敏类型：
  - `phone`：替换为随机 1xxxxxxxxxx（保持长度）
  - `id_card`：替换为随机 18 位身份证格式
  - `email`：替换为 user_xxxxx@example.com
  - `name`：替换为随机中文姓名（从内置词库抽取）
  - `custom_mask`：用户指定固定替换值（如 `***`）
  - `regex_replace`：用户提供正则 + 替换模板（高级）
- 脱敏后同一列的相同原始值替换为相同假值（保持一致性，方便关联查询）
- 大文件走 Rust 处理

**边界情况**：
- 列名不存在时跳过该规则并警告
- 替换后的值长度变化不影响 SQL 语法正确性（字符串类型）

---

#### F-06: 表名 / 列名批量替换

**场景**：`INSERT INTO \`prod_user\`` 改成 `INSERT INTO \`test_user\``；或字段名映射（跨环境部署）。

**业务规则**：
- 用户配置替换规则列表，每条：原名 → 新名（支持表名和列名）
- 规则类型：精确匹配（默认）或 前缀替换（如 prod_ → test_）
- 同时替换 INSERT INTO 后的表名 和 列名列表中的列名
- 支持批量规则（多条同时生效）
- 大文件走 Rust 流式替换

---

#### F-07: INSERT 转 UPDATE / UPSERT

**场景**：把 INSERT 转成 `UPDATE ... WHERE id=?` 或 `INSERT ... ON DUPLICATE KEY UPDATE`，用于数据修复场景。

**业务规则**：
- 用户指定主键列名（WHERE 条件列）
- 输出模式（三选一）：
  - `UPDATE`：生成 `UPDATE table SET col=val, ... WHERE pk=val`
  - `INSERT ... ON DUPLICATE KEY UPDATE`（MySQL UPSERT）
  - `INSERT ... ON CONFLICT DO UPDATE`（PostgreSQL UPSERT）
- 可选：排除某些列不参与 SET（如 created_at）
- 大文件走 Rust 流式转换

**边界情况**：
- INSERT 语句无列名时提示用户先补充列名（或手动指定主键为第几列）

---

### P2：中低频实用功能

#### F-08: 主键 ID 偏移

**场景**：两个数据库合并时，把一方所有 ID 加上偏移量（如 +1000000）避免主键冲突。

**业务规则**：
- 用户指定偏移列名（如 id）和偏移量（整数，支持负数）
- 仅修改 VALUES 中对应列的数值，不影响其他列
- 支持同时偏移多列（如 id 和 parent_id）
- 大文件走 Rust 流式处理

**边界情况**：
- 指定列的值不是纯数字时跳过该行并警告
- 偏移后超出 BIGINT 范围时警告

---

#### F-09: 多文件合并

**场景**：把多个 SQL 文件合并成一个，统一处理后再导入。与 F-01~F-03 的区别：这里是文件级合并，不是语句级合并（REQ-001 的合并功能是单条→批量）。

**业务规则**：
- 用户选择多个 SQL 文件（拖拽或文件选择器多选）
- 合并顺序：用户可拖拽调整文件顺序
- 可选：去除各文件中的重复 SET 语句（如 SET NAMES utf8mb4 只保留一次）
- 可选：在每个文件内容之间插入分隔注释（如 `-- === file: xxx.sql ===`）
- 输出到单个文件（用户指定路径）
- 全程 Rust 流式，逐文件追加写出

---

### P3：低频分析辅助

#### F-10: 文件统计分析

**场景**：读入一个大 SQL 文件，输出有哪些表、每张表多少行、总数据量，不做任何修改。

**业务规则**：
- 扫描文件中所有 INSERT INTO 语句
- 输出统计表：表名 | 行数 | 估算数据大小
- 同时展示：总语句数、文件大小、扫描耗时
- 结果可复制为 CSV 或 Markdown 表格
- 全程 Rust 流式，只读不写

---

#### F-11: 方言转换

**场景**：MySQL 语法真正转成 PostgreSQL 语法（不只是格式化），用于跨数据库迁移。

**业务规则**：
- 支持的转换方向（第一阶段）：MySQL → PostgreSQL
- 转换内容：
  - Backtick → 双引号（标识符引用）
  - `AUTO_INCREMENT` → `SERIAL` / `GENERATED ALWAYS AS IDENTITY`
  - `TINYINT(1)` → `BOOLEAN`
  - `DATETIME` → `TIMESTAMP`
  - `\`ENGINE=InnoDB\`` 等 MySQL 专有子句 → 删除
  - 字符串连接 `CONCAT(a,b)` → `a || b`（可选，高风险）
- 转换规则以规则列表形式展示，用户可逐条开关
- 仅支持小文件（≤10MB），超出提示不支持（规则复杂，流式处理难度大）

---

#### F-12: SQL Diff

**场景**：对比两个 SQL dump 文件，找出新增/删除/修改的行，用于数据变更审计。

**业务规则**：
- 输入：两个 SQL 文件（Left / Right）
- 对比维度：
  - 按主键列（用户指定）进行行级对比
  - 输出：仅在 Left 中存在（已删除）、仅在 Right 中存在（新增）、两边都有但值不同（修改）
- 结果展示：Diff 视图（左右对比），修改的字段高亮
- 可导出 Diff 报告（HTML 或 CSV）
- 仅支持小文件（≤10MB），大文件 Diff 建议用数据库工具

---

## 技术约束与架构决策

| 约束点 | 规则 |
|--------|------|
| 大文件阈值 | 沿用 REQ-001 标准：>10MB 走 Rust 流式 |
| CSV 解析库 | 前端使用 `papaparse`（轻量，纯 JS，支持流式） |
| Excel 读写库 | 前端使用 `xlsx`（SheetJS） |
| 随机数据生成 | 数据脱敏用前端 JS 库（`@faker-js/faker`），支持中文 locale |
| 新增 Rust 命令 | 每个大文件功能新增对应 Tauri command，沿用 `stream-progress` 事件上报进度 |
| UI 模式 | 新功能沿用左侧导航 + 步骤流式布局，与现有页面保持一致 |
| F-11/F-12 | 明确限制仅支持小文件，避免引入超出当前 Rust 处理复杂度的需求 |

## 实现优先级与建议顺序

```
Sprint 1: F-03（按表名抽取） + F-01（SQL→CSV）
  — 纯数据提取，无复杂规则，可快速出产品价值

Sprint 2: F-02（CSV→SQL） + F-09（多文件合并）
  — 与 Sprint 1 互为逆操作，用户期望强

Sprint 3: F-04（去重） + F-06（表名替换）
  — 数据治理入口功能，规则简单明确

Sprint 4: F-07（INSERT→UPDATE/UPSERT） + F-08（主键偏移）
  — 数据修复场景，有明确使用路径

Sprint 5: F-05（脱敏） + F-10（统计分析）
  — 脱敏规则复杂，单独一个 sprint；统计可搭车

Sprint 6: F-11（方言转换） + F-12（SQL Diff）
  — 复杂度最高，且有使用限制，最后做
```

## 关键文件索引（预期新增）

### 前端层（src/）

- `src/pages/Extract.tsx` — F-03 按表名抽取页
- `src/pages/Export.tsx` — F-01 SQL→CSV/Excel 导出页
- `src/pages/Import.tsx` — F-02 CSV/Excel→SQL 页
- `src/pages/Dedupe.tsx` — F-04 数据去重页
- `src/pages/Mask.tsx` — F-05 数据脱敏页
- `src/pages/Rename.tsx` — F-06 表名/列名替换页
- `src/pages/Convert.tsx` — F-07 INSERT→UPDATE/UPSERT 页
- `src/pages/Offset.tsx` — F-08 主键偏移页
- `src/pages/FileMerge.tsx` — F-09 多文件合并页
- `src/pages/Stats.tsx` — F-10 文件统计分析页
- `src/pages/Dialect.tsx` — F-11 方言转换页
- `src/pages/Diff.tsx` — F-12 SQL Diff 页

### Tauri 层（src-tauri/）

- `src-tauri/src/commands/extract.rs` — F-03 F-10 Rust 命令
- `src-tauri/src/commands/transform.rs` — F-04 F-06 F-07 F-08 Rust 命令
- `src-tauri/src/commands/convert.rs` — F-01 F-02 CSV/Excel Rust 辅助命令

## 遗留问题 / 后续确认

- [ ] F-02 xlsx 多 Sheet 场景：表名是否允许用户在 UI 覆盖 Sheet 名？
- [ ] F-05 脱敏一致性（同原始值 → 同假值）：是否需要跨文件会话保持一致（需要种子概念）？
- [ ] F-07 UPSERT 语法：是否需要同时支持 SQLite 的 `INSERT OR REPLACE`？
- [ ] F-09 多文件合并：是否需要在合并后自动触发 F-04 去重？（可能是高频组合）
- [ ] F-12 Diff：对比维度是否需要支持"忽略列"（如忽略 updated_at 的差异）？
- [ ] 导航栏图标：12 个功能需重新规划左侧导航分组（可能需要折叠分组）
- [ ] REQ-001 遗留：Node.js 版本升级（20.17 → 22.12+），建议在 Sprint 1 前解决

## 实现进度

| 功能 | 状态 | 完成版本 |
|------|------|----------|
| F-01 SQL→CSV/Excel | ✅ 已完成 | v1.1 |
| F-02 CSV/Excel→SQL（基础版） | ✅ 已完成 | v1.1 |
| F-02 batch INSERT / 数值检测 / noHeader | ✅ 已完成 | v1.2 |
| F-03 按表名抽取 | ✅ 已完成 | v1.1 |
| F-04 数据去重 | ✅ 已完成 | v1.3 |
| F-05 数据脱敏 | ✅ 已完成 | v1.7 |
| F-06 表名/列名批量替换 | ✅ 已完成 | v1.4 |
| F-07 INSERT→UPDATE/UPSERT | ✅ 已完成 | v1.4 |
| F-08 主键 ID 偏移 | ✅ 已完成 | v1.4 |
| F-09 多文件合并 | ✅ 已完成 | v1.5 |
| F-10 文件统计分析 | ✅ 已完成 | v1.4 |
| F-11 方言转换 | ✅ 已完成 | v1.5 |
| F-12 SQL Diff | ✅ 已完成 | v1.5 |

## 变更记录

### v1.7 — 2026-04-16 — F-05 数据脱敏

- **分支**: master | **提交**: `5fd0b38`
- **变更摘要**:
  - `mask.ts`: 6种脱敏类型（phone/id_card/email/name/custom_mask/regex_replace）
  - hash-seed 一致性：相同列+原始值 → 相同假数据，跨行保持一致
  - `mask.test.ts`: 11个测试，全部通过
  - `Mask.tsx`: StepFlow UI，动态规则列表，custom/regex 扩展输入
  - Rust `mask_sql`: 流式处理 + HashMap cache 保持一致性，regex crate 支持正则替换

### v1.6 — 2026-04-16 — F-09/F-11/F-12 三功能

- **分支**: master | **提交**: `a903181`
- **变更摘要**:
  - F-09: `FileMerge.tsx` 多文件选择+排序 UI；Rust `merge_sql_files` 流式追加，去重 SET 语句
  - F-11: `dialect.ts` 9条可开关 MySQL→PostgreSQL 转换规则；`Dialect.tsx` 规则勾选 UI
  - F-12: `diff.ts` 两 Map 对比，added/removed/modified/unchanged 分类；`Diff.tsx` 左右双栏+行级 diff 卡片
  - Sidebar 滚动导航扩展至 14 项

### v1.5 — 2026-04-16 — F-06/F-07/F-08/F-10 四功能 + Sidebar 重构

- **分支**: master | **提交**: `92e867a`
- **变更摘要**:
  - F-06: `rename.ts/Rename.tsx` — 表名精确/前缀替换、列名替换，Rust `rename_sql`（regex crate）
  - F-07: `convert_stmt.ts/ConvertStmt.tsx` — INSERT → UPDATE/MySQL UPSERT/PG UPSERT，Rust `convert_statements`
  - F-08: `offset.ts/Offset.tsx` — 数值列加偏移量，跳过非数值并警告，Rust `offset_sql`
  - F-10: `stats.ts/Stats.tsx` — 每表行数/大小统计，输出 Markdown/CSV，Rust `analyze_sql_file`
  - Rust 共享 `parse_insert_parts` + `tokenize_sql_values` helpers
  - Sidebar 滚动导航，h-10 紧凑布局

### v1.4 — 2026-04-16 — F-04 归档更新 + REQ 状态

- **分支**: master | **提交**: `3ecc823`（参见 v1.3 详情）

### v1.3 — 2026-04-16 — F-04 数据去重

- **分支**: master | **提交**: `3ecc823`
- **变更摘要**:
  - `dedupe.ts`: `parseSqlValues` / `parseInsertLine` / `dedupeSql` — 两轮扫描，per-table 去重
  - 支持按列名（不区分大小写）或 1-based 列序号定位去重键
  - keepLast 选项：保留最后一条（默认）或第一条；non-INSERT 行原样保留
  - `dedupe.test.ts`: 20 个测试，全部通过（共 78 个）
  - `Dedupe.tsx`: StepFlow 3 步 UI，小文件 JS 内联 + 大文件 Rust 流式 + 进度条
  - Rust `dedupe_sql` 命令：两遍 IO + `HashMap<(table, key), line_no>`，支持 progress 事件
  - Sidebar/App.tsx 新增"去重"导航入口（`CopyMinus` 图标）

### v1.2 — 2026-04-16 — F-02 功能补全

- **分支**: master | **提交**: `d02bd88`
- **变更摘要**:
  - `csvToSql` 改为接受 `CsvToSqlOptions` 对象（新增 `noHeader`, `batchSize`, `detectNumeric`）
  - 数值列自动检测：整列均为纯数字时输出不加引号（JS + Rust 两侧均实现）
  - 批量 INSERT：前端可配置 batch_size（默认 1000），JS 和 Rust 均支持
  - 无列名行选项：列名自动生成为 col1, col2…（JS + Rust 两侧均实现）
  - Rust `import_csv_to_sql` 两遍扫描实现数值检测（O(1) 内存，O(2n) IO）
  - Excel 侧改用 calamine 原生类型（Data::Float → 不加引号）
  - 新增 8 个单元测试（共 58 个通过）
  - Convert.tsx ImportFlow 新增 UI 控件：无列名行 / 批量 INSERT / 每批行数

### v1.1 — 2026-04-15 — Sprint 1b 实现

- **分支**: master | **提交**: `91e0cd9`
- **变更摘要**: 实现 F-01（SQL→CSV/Excel）、F-02 基础版（CSV/Excel→SQL）、F-03（按表名抽取）
- **关联需求**: REQ-001 v1.1（基础平台架构）

### v1.0 — 2026-04-15 — 初始需求规划

- **阶段**: 需求分析 + 功能规划
- **变更摘要**: 基于 DBA/开发者实际工作场景，定义 12 个新功能，按价值高低分为 P0/P1/P2/P3 四个优先级，规划 6 个 Sprint 的实现顺序
- **关联需求**: REQ-001 v1.1（基础平台架构）

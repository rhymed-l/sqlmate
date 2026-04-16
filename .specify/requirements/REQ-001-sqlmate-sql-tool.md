# REQ-001: SQLMate — 跨平台 SQL 处理桌面工具

> 创建时间: 2026-04-14 | 状态: 已完成 | 阶段: 已发布

## 需求背景

开发者在处理大批量数据库脚本时，常需要对 INSERT 语句进行合并、拆分、大文件切割、格式美化等重复性操作。SQLMate 是一个本地桌面工具，解决这些高频需求，无需上传数据到云端，安全可控，跨平台运行。

## 核心功能

1. **SQL 合并** — 将多条独立的 INSERT INTO 语句合并为批量插入语句，每批条数可配置（默认 1000）
2. **SQL 拆分** — 将批量 INSERT 语句拆回单条语句，与合并互为逆操作
3. **SQL 分割** — 将大 SQL 文件拆分为多个文件，支持按语句条数或文件大小两种模式
4. **SQL 格式化** — 美化 SQL 缩进与结构，支持多方言下拉选择（MySQL / PostgreSQL / SQL Server / Oracle 等）

## 业务规则

- **合并批次**：默认每批 1000 条，用户可在步骤 2 中修改，范围不限
- **拆分逻辑**：识别 VALUES 后的多组括号，逐一拆出为独立 INSERT 语句
- **分割模式**：按条数（每文件 X 条）和按大小（每文件不超过 X MB）二选一，均可配置
- **输入方式**：支持直接粘贴文本 或 拖拽/点击选择文件，两者等价
- **大文件阈值**：超过 10MB 的文件自动进入大文件模式，内容不加载到内存，仅记录路径
- **大文件输出**：合并 / 拆分 / 分割大文件模式下，强制弹出保存对话框，输出直接写磁盘，无复制操作（几 GB 数据复制无意义）
- **小文件输出**：
  - 合并 / 拆分 / 格式化：结果可复制到剪贴板，也可保存为单个文件
  - 分割：结果强制保存到用户指定文件夹（因为是多文件输出）
- **格式化限制**：格式化功能拒绝大文件（>10MB），提示不支持
- **格式化方言**：用户通过下拉框选择目标方言，默认 MySQL
- **主题**：深色/浅色双模式，跟随系统，也可手动切换

## 设计决策

| 决策点 | 选择 | 原因 |
|--------|------|------|
| 桌面框架 | Tauri 2.0 | 体积 ~10MB，使用系统 WebView，非 Electron（150MB+）或 Wails（50MB+） |
| 前端框架 | React 19 + TypeScript | 团队熟悉 JS/TS，生态丰富 |
| UI 组件库 | shadcn/ui + Tailwind CSS | 高质感可定制，不额外增加体积 |
| SQL 格式化库 | sql-formatter | 纯 JS，支持多方言，无需服务端 |
| SQL 处理层（小文件） | TypeScript 前端层 | ≤10MB 时字符串处理足够，无需 Rust |
| SQL 处理层（大文件） | Rust 流式（BufReader/BufWriter） | 内存 O(1条语句)，支持无上限文件大小；JS 在浏览器环境无法高效流式处理 |
| 文件 I/O | Tauri FS API（Rust） | 读大文件、写多文件、选文件夹对话框 |
| 进度上报 | Tauri 事件（stream-progress） | 每完成 1% 触发一次，最多 100 次 IPC，避免刷爆前端消息队列 |
| merge_file 内存策略 | 攒够 batch_size 立即写盘 | 内存上限 = 表数 × batch_size，与文件总大小无关 |
| 布局 | 左侧图标导航 | 类 VS Code 风格，功能切换直观，内容区宽裕 |
| 交互模式 | 步骤流式（① 输入 → ② 配置 → ③ 结果） | 引导感强，参数配置清晰 |
| 主题色 | 紫蓝渐变（#7c8cf8 → #a78bfa） | 科技感，开发工具气质 |
| 为何不选 Flutter | 环境搭建成本高（~10GB），且 Dart 不熟悉 | Tauri 只需 Rust 工具链 ~1.5GB，TS 是主力语言 |

## 关键文件索引

> 项目尚未初始化，待 Tauri 脚手架生成后补充

### 前端层（src/）
- `src/App.tsx` — 根组件，路由/主题切换入口
- `src/pages/Merge.tsx` — SQL 合并功能页（小文件 JS / 大文件 Rust）
- `src/pages/Split.tsx` — SQL 拆分功能页（小文件 JS / 大文件 Rust）
- `src/pages/Segment.tsx` — SQL 分割功能页（始终 Rust）
- `src/pages/Format.tsx` — SQL 格式化功能页（拒绝大文件）
- `src/lib/sql/merge.ts` — 小文件合并逻辑（JS）
- `src/lib/sql/split.ts` — 小文件拆分逻辑（JS）
- `src/lib/sql/segment.ts` — 小文件分割逻辑（JS）
- `src/components/SqlEditor.tsx` — 输入区，含大文件检测（>10MB 不加载内容）
- `src/components/ProgressBar.tsx` — 流式处理进度条组件
- `src/hooks/useStreamProgress.ts` — 监听 stream-progress Tauri 事件

### Tauri 层（src-tauri/）
- `src-tauri/src/commands/file.rs` — 所有 Rust 命令：segment_file / merge_file / split_file / read_file / write_file 等

## 变更记录

### v1.0 — 2026-04-14 — 初始设计
- **阶段**: 需求 + 技术选型 + UI 设计
- **变更摘要**: 完成技术选型（Tauri）、UI 风格（双模式紫蓝渐变）、布局（左侧导航+步骤流式）、4 大功能边界定义
- **提交**: 尚未开始编码

### v1.1 — 2026-04-14 — 功能实现 + 大文件流式 + 发布
- **变更摘要**: 完成全部功能编码，引入大文件流式处理架构，修复多个关键 bug，打包 Windows 安装包
- **关键修复**:
  - `src/main.tsx` 缺少 `import "./index.css"` 导致 UI 完全无样式
  - `split_file` 正则 raw string 末尾 `\<换行>` 被解释为"匹配换行符"，导致所有语句解析失败输出 0 条
  - 结果面板被内容撑开横向滚动：改用 `break-all` + `overflow-x-hidden`
- **新增功能**:
  - 大文件模式（>10MB）：`LargeFileInfo` 仅存路径，内容不过 IPC
  - Rust 流式命令：`segment_file`、`split_file`（纯流式 O(1条语句)）、`merge_file`（内存上限 O(表数×batch_size)）
  - 实时进度条：Rust 每 1% 发一次 `stream-progress` 事件，前端 `useStreamProgress` hook 监听
  - 大文件合并/拆分强制弹出保存对话框，不提供复制
- **新增设计决策**: 大文件走 Rust 流式，小文件走 JS；merge_file 攒满 batch_size 立即写盘
- **产物**: `SQLMate_0.1.0_x64_en-US.msi` + `SQLMate_0.1.0_x64-setup.exe`

## 遗留问题 / 后续优化

- [x] 大文件处理性能边界：超过 10MB 进入流式模式
- [x] 分割功能的输出文件命名规则：`output_001.sql`, `output_002.sql`, ...
- [ ] 确认 SQL 合并是否只针对 INSERT INTO，还是也支持其他语句类型
- [ ] 是否需要操作历史记录功能
- [ ] 应用图标设计
- [ ] Node.js 版本警告（当前 20.17，Vite 要求 20.19+ 或 22.12+），需升级
- [ ] JS bundle 超过 500KB 警告，可按路由做 dynamic import 懒加载拆包

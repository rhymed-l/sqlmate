<div align="center">
  <img src="src-tauri/icons/128x128@2x.png" alt="SQLMate Logo" width="96" />
  <h1>SQLMate</h1>
  <p>A local-first desktop toolkit for SQL data processing — no cloud, no upload, no limits.</p>

  <p>
    <a href="https://github.com/rhymed-l/sqlmate/releases"><img src="https://img.shields.io/github/v/release/rhymed-l/sqlmate?style=flat-square&color=6366f1" alt="Release" /></a>
    <a href="https://github.com/rhymed-l/sqlmate/actions/workflows/build.yml"><img src="https://img.shields.io/github/actions/workflow/status/rhymed-l/sqlmate/build.yml?style=flat-square&label=build" alt="Build" /></a>
    <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey?style=flat-square" alt="Platform" />
    <img src="https://img.shields.io/badge/built%20with-Tauri%202%20%2B%20Rust-orange?style=flat-square" alt="Built with Tauri" />
    <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License" />
  </p>

  <p>
    <a href="#-features">Features</a> ·
    <a href="#-download">Download</a> ·
    <a href="#-development">Development</a> ·
    <a href="#-tech-stack">Tech Stack</a>
  </p>
</div>

---

## Overview

SQLMate is a cross-platform desktop application built for developers and DBAs who deal with SQL dump files daily. It handles everything from merging and splitting INSERT statements to DDL comparison and data masking — all **100% offline**, no server involved.

> Files never leave your machine. Everything runs locally via a Rust backend.

---

## ✨ Features

### Core SQL Processing

| Feature | Description |
|---|---|
| **Merge** | Combine multiple single-row `INSERT` statements into batch inserts (configurable batch size) |
| **Split** | Expand batch `INSERT` statements back into individual rows |
| **Segment** | Split a large SQL file into multiple files by row count or file size |
| **Format** | Beautify SQL with dialect-aware formatting (MySQL, PostgreSQL, SQL Server, Oracle, etc.) |

### Data Conversion

| Feature | Description |
|---|---|
| **SQL → CSV / Excel** | Extract INSERT data into spreadsheet format; multi-table → multi-sheet |
| **CSV / Excel → SQL** | Import spreadsheet data as INSERT statements with batch mode and numeric detection |
| **Dialect Convert** | Translate MySQL syntax to PostgreSQL (AUTO_INCREMENT → SERIAL, backticks → double quotes, etc.) |
| **INSERT → UPDATE / UPSERT** | Rewrite INSERT statements as UPDATE, MySQL UPSERT, or PostgreSQL ON CONFLICT |

### Data Governance

| Feature | Description |
|---|---|
| **Extract by Table** | Scan a large dump and extract only the tables you need |
| **Deduplicate** | Remove duplicate rows by key column; keep first or last |
| **Mask** | Replace PII (phone, ID card, email, name) with realistic fake data while preserving referential consistency |
| **Rename** | Batch rename table names or column names with exact match or prefix replacement |
| **ID Offset** | Shift primary key values by a fixed amount to avoid conflicts when merging databases |

### Analysis & Comparison

| Feature | Description |
|---|---|
| **Stats** | Count rows per table, estimate data size, output as Markdown or CSV |
| **SQL Diff** | Compare two SQL dumps row-by-row by primary key; highlight added / removed / modified rows |
| **DDL Diff** | Compare two `CREATE TABLE` DDLs and auto-generate `ALTER TABLE` statements for MySQL, PostgreSQL, or Oracle |
| **File Merge** | Concatenate multiple SQL files into one with deduplication of SET statements |

---

## 📥 Download

Pre-built binaries are available on the [Releases](https://github.com/rhymed-l/sqlmate/releases) page.

| Platform | Installer |
|---|---|
| Windows x64 | `.msi` (Windows Installer) or `.exe` (NSIS setup) |
| macOS Apple Silicon | `.dmg` (arm64) |
| macOS Intel | `.dmg` (x64) |

> **macOS note:** The app is not notarized. On first launch, right-click → Open → Open to bypass Gatekeeper.

---

## 🏗 Architecture

SQLMate uses a two-tier processing strategy based on file size:

```
Input File
    │
    ├── ≤ 10 MB ──► TypeScript (Web Worker)
    │                Pure JS string processing, result displayed in-app
    │
    └── > 10 MB ──► Rust (Tauri Command)
                     Streaming BufReader/BufWriter, O(1) memory,
                     progress events emitted every 1%
```

**Key design decisions:**

- **Tauri 2 over Electron** — ~10 MB binary vs 150 MB+, uses system WebView
- **Rust streaming** — processes multi-GB files with constant memory usage
- **Web Worker** — keeps the UI thread responsive during JS processing
- **Local-only** — zero network calls, data never leaves the machine

---

## 🛠 Tech Stack

| Layer | Technology |
|---|---|
| Desktop framework | [Tauri 2.0](https://tauri.app/) |
| Frontend | React 19 + TypeScript |
| UI components | [shadcn/ui](https://ui.shadcn.com/) + Tailwind CSS |
| Backend | Rust (streaming I/O via `BufReader` / `BufWriter`) |
| SQL formatting | [sql-formatter](https://github.com/sql-formatter-org/sql-formatter) |
| CSV parsing | [PapaParse](https://www.papaparse.com/) |
| Excel read/write | [SheetJS](https://sheetjs.com/) |
| Testing | [Vitest](https://vitest.dev/) |
| Build / CI | GitHub Actions (Windows + macOS arm64 + macOS x64) |

---

## 💻 Development

### Prerequisites

- [Node.js](https://nodejs.org/) 22+
- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Tauri CLI prerequisites](https://tauri.app/start/prerequisites/) for your platform

### Setup

```bash
# Clone the repo
git clone https://github.com/rhymed-l/sqlmate.git
cd sqlmate

# Install frontend dependencies
npm install

# Start dev server (hot reload)
npm run tauri dev
```

### Build

```bash
# Production build (current platform)
npm run tauri build
```

Installers are output to `src-tauri/target/release/bundle/`.

### Test

```bash
# Run all unit tests
npm test

# Watch mode
npm run test:watch
```

The test suite covers all business logic in `src/lib/sql/` (177 tests as of v0.1.0).

---

## 📁 Project Structure

```
sqlmate/
├── src/                      # Frontend (React + TypeScript)
│   ├── pages/                # One file per feature (Merge, Split, DdlDiff, …)
│   ├── lib/sql/              # Pure business logic + unit tests
│   ├── components/           # Shared UI components (SqlEditor, ResultPanel, …)
│   ├── hooks/                # React hooks (useSqlWorker, useTheme, …)
│   └── workers/              # Web Worker entry point
├── src-tauri/                # Rust backend
│   └── src/
│       └── commands/         # Tauri commands (streaming file processing)
└── .github/workflows/        # CI: build for Windows + macOS
```

---

## 🤝 Contributing

Contributions are welcome. Please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create your feature branch (`git checkout -b feat/my-feature`)
3. Commit your changes (`git commit -m 'feat: add my feature'`)
4. Push to the branch (`git push origin feat/my-feature`)
5. Open a Pull Request

---

## 📄 License

[MIT](LICENSE)

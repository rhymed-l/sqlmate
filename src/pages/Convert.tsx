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
  const [sheetMaps, setSheetMaps] = useState<SheetMap[]>([]);
  const [scanning, setScanning] = useState(false);
  const [csvTableName, setCsvTableName] = useState("");
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

    setFilePath(path);
    setSheetMaps([]);
    setCsvTableName("");
    setSmallResult(null);
    setLargeResult(null);
    setError(null);
    setScanning(false);
    setIsLarge(false);

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
          setLargeResult({ rowCount: stats.row_count, tableCount: stats.table_count, outputPath });
        } catch (e) {
          setError(`处理失败: ${e}`);
        } finally {
          stopProgress();
          setProcessing(false);
        }
      }
    } else {
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
    fileType !== null &&
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
            <ResultPanel content={smallResult} meta="CSV → SQL 转换完成" />
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

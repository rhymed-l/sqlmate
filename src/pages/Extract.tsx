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

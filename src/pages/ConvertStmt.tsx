import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { StepFlow } from "@/components/StepFlow";
import { SqlEditor, type LargeFileInfo } from "@/components/SqlEditor";
import { ResultPanel } from "@/components/ResultPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle, Loader2 } from "lucide-react";
import { convertStatements, type ConvertMode } from "@/lib/sql/convert_stmt";
import { useStreamProgress } from "@/hooks/useStreamProgress";
import { ProgressBar } from "@/components/ProgressBar";

const MODE_OPTIONS: { value: ConvertMode; label: string; desc: string }[] = [
  { value: "update", label: "UPDATE", desc: "UPDATE table SET ... WHERE pk=val" },
  {
    value: "mysql_upsert",
    label: "MySQL UPSERT",
    desc: "INSERT ... ON DUPLICATE KEY UPDATE",
  },
  {
    value: "pg_upsert",
    label: "PostgreSQL UPSERT",
    desc: "INSERT ... ON CONFLICT DO UPDATE SET",
  },
];

export function ConvertStmt() {
  const [input, setInput] = useState("");
  const [largeFile, setLargeFile] = useState<LargeFileInfo | null>(null);

  const [mode, setMode] = useState<ConvertMode>("update");
  const [pkColumn, setPkColumn] = useState("");
  const [excludeColumns, setExcludeColumns] = useState(""); // comma-separated

  const [result, setResult] = useState<{ sql: string; meta: string } | null>(null);
  const [largeResult, setLargeResult] = useState<{
    convertedCount: number;
    skippedCount: number;
    outputPath: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const { progress, startProgress } = useStreamProgress();
  const hasInput = !!input.trim() || !!largeFile;
  const canExecute = hasInput && !processing && pkColumn.trim() !== "";

  function resetResults() {
    setResult(null);
    setLargeResult(null);
    setError(null);
  }

  const excludeArr = excludeColumns
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  async function handleExecute() {
    setError(null);
    setResult(null);
    setLargeResult(null);

    if (largeFile) {
      const outputPath = await save({
        filters: [{ name: "SQL Files", extensions: ["sql"] }],
        defaultPath: "converted.sql",
      });
      if (!outputPath) return;

      setProcessing(true);
      const stopProgress = await startProgress();
      try {
        const stats = await invoke<{
          converted_count: number;
          skipped_count: number;
        }>("convert_statements", {
          inputPath: largeFile.path,
          outputPath,
          mode,
          pkColumn: pkColumn.trim(),
          excludeColumns: excludeArr,
        });
        setLargeResult({
          convertedCount: stats.converted_count,
          skippedCount: stats.skipped_count,
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

    setProcessing(true);
    await new Promise((r) => setTimeout(r, 0));
    try {
      const { sql, convertedCount, skippedCount } = convertStatements(input, {
        mode,
        pkColumn: pkColumn.trim() || undefined,
        excludeColumns: excludeArr,
      });
      setResult({
        sql,
        meta: `已转换 ${convertedCount} 条${skippedCount > 0 ? `，跳过 ${skippedCount} 条（无法解析主键）` : ""}`,
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
              placeholder="粘贴包含 INSERT 语句的 SQL，或拖拽 .sql / .txt 文件..."
            />
          ),
        },
        {
          number: 2,
          label: "转换配置",
          children: (
            <div className="space-y-4">
              {/* Mode */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">输出模式</p>
                {MODE_OPTIONS.map((opt) => (
                  <label key={opt.value} className="flex items-start gap-2 cursor-pointer">
                    <input
                      type="radio"
                      checked={mode === opt.value}
                      onChange={() => setMode(opt.value)}
                      className="accent-indigo-500 mt-0.5"
                    />
                    <div>
                      <span className="text-sm font-medium">{opt.label}</span>
                      <p className="text-xs text-muted-foreground font-mono">{opt.desc}</p>
                    </div>
                  </label>
                ))}
              </div>

              {/* PK column */}
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">主键列名 *</p>
                <Input
                  value={pkColumn}
                  onChange={(e) => setPkColumn(e.target.value)}
                  placeholder="例如：id"
                  className="font-mono text-sm max-w-xs"
                />
                <p className="text-xs text-muted-foreground">
                  用于 WHERE 条件或 ON CONFLICT 子句，不区分大小写
                </p>
              </div>

              {/* Exclude columns */}
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">排除列（可选）</p>
                <Input
                  value={excludeColumns}
                  onChange={(e) => setExcludeColumns(e.target.value)}
                  placeholder="created_at, deleted_at"
                  className="font-mono text-sm max-w-xs"
                />
                <p className="text-xs text-muted-foreground">逗号分隔，这些列不参与 SET 更新</p>
              </div>

              <div className="flex items-center gap-3 flex-wrap">
                <Button
                  onClick={handleExecute}
                  disabled={!canExecute}
                  className="bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white shadow-md shadow-indigo-500/20"
                >
                  {processing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                  {processing ? "处理中..." : largeFile ? "选择保存位置并执行" : "执行转换"}
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
                <p className="text-sm font-medium">转换完成</p>
                <p className="text-xs text-muted-foreground">
                  已转换 {largeResult.convertedCount} 条
                  {largeResult.skippedCount > 0 &&
                    `，跳过 ${largeResult.skippedCount} 条`}
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

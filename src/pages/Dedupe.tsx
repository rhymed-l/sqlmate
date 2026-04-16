import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { StepFlow } from "@/components/StepFlow";
import { SqlEditor, type LargeFileInfo } from "@/components/SqlEditor";
import { ResultPanel } from "@/components/ResultPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle, Loader2 } from "lucide-react";
import type { DedupeResult } from "@/lib/sql/dedupe";
import { useSqlWorker } from "@/hooks/useSqlWorker";
import { useStreamProgress } from "@/hooks/useStreamProgress";
import { ProgressBar } from "@/components/ProgressBar";

interface DedupeStats {
  original_count: number;
  kept_count: number;
  removed_count: number;
  output_path?: string;
}

export function Dedupe() {
  const [input, setInput] = useState("");
  const [largeFile, setLargeFile] = useState<LargeFileInfo | null>(null);

  // Step 2 config
  const [useColumnName, setUseColumnName] = useState(true); // true=column name, false=column index
  const [keyColumn, setKeyColumn] = useState("");
  const [keyColIndex, setKeyColIndex] = useState("1");
  const [keepLast, setKeepLast] = useState(true);

  const [result, setResult] = useState<{ sql: string; meta: string } | null>(null);
  const [largeResult, setLargeResult] = useState<DedupeStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const { progress, startProgress } = useStreamProgress();
  const { call } = useSqlWorker();
  const hasInput = !!input.trim() || !!largeFile;

  const canExecute =
    hasInput &&
    !processing &&
    (useColumnName ? keyColumn.trim() !== "" : parseInt(keyColIndex, 10) >= 1);

  function resetResults() {
    setResult(null);
    setLargeResult(null);
    setError(null);
  }

  async function handleExecute() {
    setError(null);
    setResult(null);
    setLargeResult(null);

    const colIndex = useColumnName ? undefined : parseInt(keyColIndex, 10);
    const colName = useColumnName ? keyColumn.trim() : undefined;

    if (largeFile) {
      const outputPath = await save({
        filters: [{ name: "SQL Files", extensions: ["sql"] }],
        defaultPath: "deduped.sql",
      });
      if (!outputPath) return;

      setProcessing(true);
      const stopProgress = await startProgress();
      try {
        const stats = await invoke<DedupeStats>("dedupe_sql", {
          inputPath: largeFile.path,
          outputPath,
          keyColumn: colName ?? null,
          keyColIndex: colIndex ?? null,
          keepLast,
        });
        setLargeResult({ ...stats, output_path: outputPath });
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
    try {
      const deduped = await call<DedupeResult>("dedupe", {
        sql: input,
        options: { keyColumn: colName, keyColIndex: colIndex, keepLast },
      });
      setResult({
        sql: deduped.sql,
        meta: `原始 ${deduped.originalCount} 条，保留 ${deduped.keptCount} 条，去除 ${deduped.removedCount} 条重复`,
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
              onChange={(v) => {
                setInput(v);
                resetResults();
              }}
              largeFile={largeFile}
              onLargeFile={(f) => {
                setLargeFile(f);
                resetResults();
              }}
              placeholder="粘贴包含 INSERT 语句的 SQL，或拖拽 .sql / .txt 文件..."
            />
          ),
        },
        {
          number: 2,
          label: "去重配置",
          children: (
            <div className="space-y-4">
              {/* Key type toggle */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">去重键</p>
                <div className="flex gap-4">
                  <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input
                      type="radio"
                      checked={useColumnName}
                      onChange={() => setUseColumnName(true)}
                      className="accent-indigo-500"
                    />
                    列名
                  </label>
                  <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input
                      type="radio"
                      checked={!useColumnName}
                      onChange={() => setUseColumnName(false)}
                      className="accent-indigo-500"
                    />
                    列序号（无列名时）
                  </label>
                </div>

                {useColumnName ? (
                  <div className="space-y-1">
                    <Input
                      value={keyColumn}
                      onChange={(e) => setKeyColumn(e.target.value)}
                      placeholder="例如：id"
                      className="font-mono text-sm max-w-xs"
                    />
                    <p className="text-xs text-muted-foreground">
                      INSERT 中带列名时使用，不区分大小写
                    </p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Input
                      type="number"
                      min={1}
                      value={keyColIndex}
                      onChange={(e) => setKeyColIndex(e.target.value)}
                      className="font-mono text-sm max-w-[120px]"
                    />
                    <p className="text-xs text-muted-foreground">
                      从 1 开始的列位置，适用于无列名的 INSERT
                    </p>
                  </div>
                )}
              </div>

              {/* Keep strategy */}
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">重复时保留</p>
                <div className="flex gap-4">
                  <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input
                      type="radio"
                      checked={keepLast}
                      onChange={() => setKeepLast(true)}
                      className="accent-indigo-500"
                    />
                    最后一条
                  </label>
                  <label className="flex items-center gap-1.5 text-sm cursor-pointer">
                    <input
                      type="radio"
                      checked={!keepLast}
                      onChange={() => setKeepLast(false)}
                      className="accent-indigo-500"
                    />
                    第一条
                  </label>
                </div>
              </div>

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
                    : largeFile
                    ? "选择保存位置并执行"
                    : "执行去重"}
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
                <p className="text-sm font-medium">去重完成</p>
                <p className="text-xs text-muted-foreground">
                  原始 {largeResult.original_count} 条，保留{" "}
                  {largeResult.kept_count} 条，去除{" "}
                  {largeResult.removed_count} 条重复
                </p>
                {largeResult.output_path && (
                  <p className="text-xs text-muted-foreground font-mono break-all">
                    {largeResult.output_path}
                  </p>
                )}
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
  );
}

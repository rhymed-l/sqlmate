import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { StepFlow } from "@/components/StepFlow";
import { SqlEditor, type LargeFileInfo } from "@/components/SqlEditor";
import { ResultPanel } from "@/components/ResultPanel";
import { Button } from "@/components/ui/button";
import { Loader2, CheckCircle } from "lucide-react";
import { splitSQL } from "@/lib/sql/split";
import { useStreamProgress } from "@/hooks/useStreamProgress";
import { ProgressBar } from "@/components/ProgressBar";

interface LargeResult {
  statementCount: number;
  outputPath: string;
}

export function Split() {
  const [input, setInput] = useState("");
  const [largeFile, setLargeFile] = useState<LargeFileInfo | null>(null);
  const [result, setResult] = useState<{ sql: string; meta: string } | null>(null);
  const [largeResult, setLargeResult] = useState<LargeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const { progress, startProgress } = useStreamProgress();
  const hasInput = !!input.trim() || !!largeFile;

  async function handleExecute() {
    setError(null);
    setResult(null);
    setLargeResult(null);

    if (largeFile) {
      // Large file: Rust streaming, output directly to disk
      const outputPath = await save({
        filters: [{ name: "SQL Files", extensions: ["sql"] }],
        defaultPath: "split_output.sql",
      });
      if (!outputPath) return;

      setProcessing(true);
      const stopProgress = await startProgress();
      try {
        const stats = await invoke<{ statement_count: number }>(
          "split_file",
          { inputPath: largeFile.path, outputPath }
        );
        setLargeResult({ statementCount: stats.statement_count, outputPath });
      } catch (e) {
        setError(`处理失败: ${e}`);
      } finally {
        stopProgress();
        setProcessing(false);
      }
      return;
    }

    // Small file: JS processing
    setProcessing(true);
    await new Promise((r) => setTimeout(r, 0));
    try {
      const { sql, statementCount } = splitSQL(input);
      if (!sql) { setError("未识别到有效的批量 INSERT 语句"); return; }
      setResult({ sql, meta: `共拆分出 ${statementCount} 条语句` });
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
          label: "输入批量 SQL",
          children: (
            <SqlEditor
              value={input}
              onChange={(v) => { setInput(v); setResult(null); setLargeResult(null); }}
              largeFile={largeFile}
              onLargeFile={(f) => { setLargeFile(f); setResult(null); setLargeResult(null); }}
              placeholder="粘贴批量 INSERT 语句（多个 VALUES），或拖拽文件..."
            />
          ),
        },
        {
          number: 2,
          label: "执行拆分",
          children: (
            <div className="flex items-center gap-3">
              <Button
                onClick={handleExecute}
                disabled={!hasInput || processing}
                className="bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white shadow-md shadow-indigo-500/20"
              >
                {processing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                {processing ? "处理中..." : largeFile ? "选择保存位置并执行" : "执行拆分"}
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
          label: "查看结果",
          children: largeResult ? (
            <div className="flex items-start gap-3 p-4 rounded-lg bg-green-500/10 border border-green-500/20">
              <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <p className="text-sm font-medium">拆分完成</p>
                <p className="text-xs text-muted-foreground">
                  共拆分出 {largeResult.statementCount} 条语句
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

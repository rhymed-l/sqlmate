import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { StepFlow } from "@/components/StepFlow";
import { SqlEditor, type LargeFileInfo } from "@/components/SqlEditor";
import { ResultPanel } from "@/components/ResultPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle, Loader2, Plus, Trash2 } from "lucide-react";
import { type OffsetRule, type OffsetResult } from "@/lib/sql/offset";
import { useSqlWorker } from "@/hooks/useSqlWorker";
import { useStreamProgress } from "@/hooks/useStreamProgress";
import { ProgressBar } from "@/components/ProgressBar";

function emptyRule(): OffsetRule {
  return { column: "", offset: 1000000 };
}

export function Offset() {
  const [input, setInput] = useState("");
  const [largeFile, setLargeFile] = useState<LargeFileInfo | null>(null);
  const [rules, setRules] = useState<OffsetRule[]>([emptyRule()]);
  const [result, setResult] = useState<{ sql: string; meta: string } | null>(null);
  const [largeResult, setLargeResult] = useState<{
    modifiedCount: number;
    skippedCount: number;
    outputPath: string;
  } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const { progress, startProgress } = useStreamProgress();
  const { call } = useSqlWorker();
  const hasInput = !!input.trim() || !!largeFile;
  const validRules = rules.filter((r) => r.column.trim() !== "");
  const canExecute = hasInput && !processing && validRules.length > 0;

  function resetResults() {
    setResult(null);
    setLargeResult(null);
    setError(null);
    setWarnings([]);
  }

  function updateRule(idx: number, patch: Partial<OffsetRule>) {
    setRules((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  async function handleExecute() {
    setError(null);
    setResult(null);
    setLargeResult(null);
    setWarnings([]);

    if (largeFile) {
      const outputPath = await save({
        filters: [{ name: "SQL Files", extensions: ["sql"] }],
        defaultPath: "offset.sql",
      });
      if (!outputPath) return;

      setProcessing(true);
      const stopProgress = await startProgress();
      try {
        const stats = await invoke<{
          modified_count: number;
          skipped_count: number;
          warnings: string[];
        }>("offset_sql", {
          inputPath: largeFile.path,
          outputPath,
          rules: validRules.map((r) => ({
            column: r.column,
            col_index: r.colIndex ?? null,
            offset: r.offset,
          })),
        });
        setLargeResult({
          modifiedCount: stats.modified_count,
          skippedCount: stats.skipped_count,
          outputPath,
        });
        setWarnings(stats.warnings);
      } catch (e) {
        setError(`处理失败: ${e}`);
      } finally {
        stopProgress();
        setProcessing(false);
      }
      return;
    }

    setProcessing(true);
    try {
      const { sql, modifiedCount, skippedCount, warnings: w } = await call<OffsetResult>("offset", { sql: input, rules: validRules });
      setResult({
        sql,
        meta: `已偏移 ${modifiedCount} 条语句${skippedCount > 0 ? `，跳过 ${skippedCount} 条（非数值）` : ""}`,
      });
      setWarnings(w);
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
          label: "配置偏移规则",
          children: (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                为指定列的数值加上偏移量（可为负数），常用于主键合并时避免冲突
              </p>
              {rules.map((rule, idx) => (
                <div key={idx} className="flex items-center gap-2 flex-wrap">
                  <Input
                    value={rule.column}
                    onChange={(e) => updateRule(idx, { column: e.target.value })}
                    placeholder="列名（如 id）"
                    className="font-mono text-sm w-32 h-8"
                  />
                  <span className="text-muted-foreground text-xs">偏移量</span>
                  <Input
                    type="number"
                    value={rule.offset}
                    onChange={(e) =>
                      updateRule(idx, { offset: parseInt(e.target.value, 10) || 0 })
                    }
                    className="font-mono text-sm w-32 h-8"
                  />
                  {rules.length > 1 && (
                    <button
                      onClick={() =>
                        setRules((prev) => prev.filter((_, i) => i !== idx))
                      }
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
              <button
                onClick={() => setRules((prev) => [...prev, emptyRule()])}
                className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300"
              >
                <Plus className="w-3 h-3" /> 添加列
              </button>

              <div className="flex items-center gap-3 flex-wrap pt-1">
                <Button
                  onClick={handleExecute}
                  disabled={!canExecute}
                  className="bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white shadow-md shadow-indigo-500/20"
                >
                  {processing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                  {processing ? "处理中..." : largeFile ? "选择保存位置并执行" : "执行偏移"}
                </Button>
                {error && <p className="text-xs text-destructive">{error}</p>}
                {progress !== null && largeFile && <ProgressBar percent={progress} />}
              </div>
              {warnings.length > 0 && (
                <div className="space-y-0.5">
                  {warnings.map((w, i) => (
                    <p key={i} className="text-xs text-yellow-500">{w}</p>
                  ))}
                </div>
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
                <p className="text-sm font-medium">偏移完成</p>
                <p className="text-xs text-muted-foreground">
                  已修改 {largeResult.modifiedCount} 条
                  {largeResult.skippedCount > 0 &&
                    `，跳过 ${largeResult.skippedCount} 条非数值`}
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

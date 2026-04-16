import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { StepFlow } from "@/components/StepFlow";
import { SqlEditor, type LargeFileInfo } from "@/components/SqlEditor";
import { ResultPanel } from "@/components/ResultPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle, Loader2, Plus, Trash2 } from "lucide-react";
import { renameSql, type RenameRule, type RuleType } from "@/lib/sql/rename";
import { useStreamProgress } from "@/hooks/useStreamProgress";
import { ProgressBar } from "@/components/ProgressBar";

const RULE_TYPE_LABELS: Record<RuleType, string> = {
  table: "表名（精确）",
  prefix: "表名前缀",
  column: "列名（精确）",
};

function emptyRule(): RenameRule {
  return { type: "table", from: "", to: "" };
}

export function Rename() {
  const [input, setInput] = useState("");
  const [largeFile, setLargeFile] = useState<LargeFileInfo | null>(null);
  const [rules, setRules] = useState<RenameRule[]>([emptyRule()]);
  const [result, setResult] = useState<{ sql: string; meta: string } | null>(null);
  const [largeResult, setLargeResult] = useState<{
    replacedCount: number;
    outputPath: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const { progress, startProgress } = useStreamProgress();
  const hasInput = !!input.trim() || !!largeFile;
  const canExecute =
    hasInput &&
    !processing &&
    rules.some((r) => r.from.trim() !== "" && r.to.trim() !== "");

  function resetResults() {
    setResult(null);
    setLargeResult(null);
    setError(null);
  }

  function updateRule(idx: number, patch: Partial<RenameRule>) {
    setRules((prev) => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  }

  function addRule() {
    setRules((prev) => [...prev, emptyRule()]);
  }

  function removeRule(idx: number) {
    setRules((prev) => prev.filter((_, i) => i !== idx));
  }

  const validRules = rules.filter((r) => r.from.trim() !== "" && r.to.trim() !== "");

  async function handleExecute() {
    setError(null);
    setResult(null);
    setLargeResult(null);

    if (largeFile) {
      const outputPath = await save({
        filters: [{ name: "SQL Files", extensions: ["sql"] }],
        defaultPath: "renamed.sql",
      });
      if (!outputPath) return;

      setProcessing(true);
      const stopProgress = await startProgress();
      try {
        const stats = await invoke<{ replaced_count: number }>("rename_sql", {
          inputPath: largeFile.path,
          outputPath,
          rules: validRules.map((r) => ({
            rule_type: r.type,
            from: r.from,
            to: r.to,
          })),
        });
        setLargeResult({ replacedCount: stats.replaced_count, outputPath });
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
      const { sql, replacedCount } = renameSql(input, validRules);
      setResult({
        sql,
        meta: `已替换 ${replacedCount} 条 INSERT 语句`,
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
          label: "配置替换规则",
          children: (
            <div className="space-y-3">
              {rules.map((rule, idx) => (
                <div key={idx} className="flex items-center gap-2 flex-wrap">
                  <select
                    value={rule.type}
                    onChange={(e) => updateRule(idx, { type: e.target.value as RuleType })}
                    className="h-8 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                  >
                    {(Object.keys(RULE_TYPE_LABELS) as RuleType[]).map((t) => (
                      <option key={t} value={t}>{RULE_TYPE_LABELS[t]}</option>
                    ))}
                  </select>
                  <Input
                    value={rule.from}
                    onChange={(e) => updateRule(idx, { from: e.target.value })}
                    placeholder="原名"
                    className="font-mono text-sm w-36 h-8"
                  />
                  <span className="text-muted-foreground text-xs">→</span>
                  <Input
                    value={rule.to}
                    onChange={(e) => updateRule(idx, { to: e.target.value })}
                    placeholder="新名"
                    className="font-mono text-sm w-36 h-8"
                  />
                  {rules.length > 1 && (
                    <button
                      onClick={() => removeRule(idx)}
                      className="text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              ))}
              <button
                onClick={addRule}
                className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300"
              >
                <Plus className="w-3 h-3" /> 添加规则
              </button>

              <div className="flex items-center gap-3 flex-wrap pt-1">
                <Button
                  onClick={handleExecute}
                  disabled={!canExecute}
                  className="bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white shadow-md shadow-indigo-500/20"
                >
                  {processing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                  {processing ? "处理中..." : largeFile ? "选择保存位置并执行" : "执行替换"}
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
                <p className="text-sm font-medium">替换完成</p>
                <p className="text-xs text-muted-foreground">
                  共替换 {largeResult.replacedCount} 条语句
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

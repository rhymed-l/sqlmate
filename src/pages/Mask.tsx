import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { StepFlow } from "@/components/StepFlow";
import { SqlEditor, type LargeFileInfo } from "@/components/SqlEditor";
import { ResultPanel } from "@/components/ResultPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CheckCircle, Loader2, Plus, Trash2 } from "lucide-react";
import { maskSql, type MaskRule, type MaskType } from "@/lib/sql/mask";
import { useStreamProgress } from "@/hooks/useStreamProgress";
import { ProgressBar } from "@/components/ProgressBar";

const MASK_TYPE_OPTIONS: { value: MaskType; label: string }[] = [
  { value: "phone",         label: "手机号" },
  { value: "id_card",       label: "身份证" },
  { value: "email",         label: "邮箱" },
  { value: "name",          label: "中文姓名" },
  { value: "custom_mask",   label: "固定替换" },
  { value: "regex_replace", label: "正则替换" },
];

function emptyRule(): MaskRule {
  return { column: "", type: "phone" };
}

export function Mask() {
  const [input, setInput] = useState("");
  const [largeFile, setLargeFile] = useState<LargeFileInfo | null>(null);
  const [rules, setRules] = useState<MaskRule[]>([emptyRule()]);

  const [result, setResult] = useState<{ sql: string; meta: string } | null>(null);
  const [largeResult, setLargeResult] = useState<{
    maskedCount: number;
    outputPath: string;
    warnings: string[];
  } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const { progress, startProgress } = useStreamProgress();
  const hasInput = !!input.trim() || !!largeFile;
  const validRules = rules.filter((r) => r.column.trim() !== "");
  const canExecute = hasInput && !processing && validRules.length > 0;

  function resetResults() {
    setResult(null);
    setLargeResult(null);
    setError(null);
    setWarnings([]);
  }

  function updateRule(idx: number, patch: Partial<MaskRule>) {
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
        defaultPath: "masked.sql",
      });
      if (!outputPath) return;

      setProcessing(true);
      const stopProgress = await startProgress();
      try {
        const stats = await invoke<{
          masked_count: number;
          warnings: string[];
        }>("mask_sql", {
          inputPath: largeFile.path,
          outputPath,
          rules: validRules.map((r) => ({
            column: r.column,
            mask_type: r.type,
            custom_value: r.customValue ?? null,
            regex_pattern: r.regexPattern ?? null,
            regex_replace: r.regexReplace ?? null,
          })),
        });
        setLargeResult({
          maskedCount: stats.masked_count,
          outputPath,
          warnings: stats.warnings,
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
    await new Promise((r) => setTimeout(r, 0));
    try {
      const { sql, maskedCount, warnings: w } = maskSql(input, validRules);
      setResult({
        sql,
        meta: `已脱敏 ${maskedCount} 条语句`,
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
          label: "脱敏规则",
          children: (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                相同原始值在同一列始终替换为相同假数据（保持关联一致性）
              </p>
              {rules.map((rule, idx) => (
                <div key={idx} className="space-y-1.5 p-2.5 rounded-lg border border-border/60 bg-muted/20">
                  <div className="flex items-center gap-2">
                    <Input
                      value={rule.column}
                      onChange={(e) => updateRule(idx, { column: e.target.value })}
                      placeholder="列名"
                      className="font-mono text-sm w-28 h-7"
                    />
                    <select
                      value={rule.type}
                      onChange={(e) => updateRule(idx, { type: e.target.value as MaskType })}
                      className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground"
                    >
                      {MASK_TYPE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                    {rules.length > 1 && (
                      <button
                        onClick={() => setRules((prev) => prev.filter((_, i) => i !== idx))}
                        className="text-muted-foreground hover:text-destructive ml-auto"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  {rule.type === "custom_mask" && (
                    <Input
                      value={rule.customValue ?? ""}
                      onChange={(e) => updateRule(idx, { customValue: e.target.value })}
                      placeholder="替换为（如 ***）"
                      className="font-mono text-sm h-7"
                    />
                  )}

                  {rule.type === "regex_replace" && (
                    <div className="flex gap-2">
                      <Input
                        value={rule.regexPattern ?? ""}
                        onChange={(e) => updateRule(idx, { regexPattern: e.target.value })}
                        placeholder="正则表达式"
                        className="font-mono text-sm h-7 flex-1"
                      />
                      <Input
                        value={rule.regexReplace ?? ""}
                        onChange={(e) => updateRule(idx, { regexReplace: e.target.value })}
                        placeholder="替换模板"
                        className="font-mono text-sm h-7 flex-1"
                      />
                    </div>
                  )}
                </div>
              ))}
              <button
                onClick={() => setRules((prev) => [...prev, emptyRule()])}
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
                  {processing ? "处理中..." : largeFile ? "选择保存位置并执行" : "执行脱敏"}
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
                <p className="text-sm font-medium">脱敏完成</p>
                <p className="text-xs text-muted-foreground">
                  已脱敏 {largeResult.maskedCount} 条语句
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

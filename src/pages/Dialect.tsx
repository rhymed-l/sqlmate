import { useState } from "react";
import { StepFlow } from "@/components/StepFlow";
import { SqlEditor } from "@/components/SqlEditor";
import { ResultPanel } from "@/components/ResultPanel";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { buildDialectRules, convertDialect, type DialectRule } from "@/lib/sql/dialect";

export function Dialect() {
  const [input, setInput] = useState("");
  const [rules, setRules] = useState<DialectRule[]>(buildDialectRules());
  const [result, setResult] = useState<{ sql: string; meta: string } | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const hasInput = !!input.trim();

  function toggleRule(id: string) {
    setRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, enabled: !r.enabled } : r))
    );
  }

  async function handleExecute() {
    setError(null);
    setResult(null);
    setProcessing(true);
    await new Promise((r) => setTimeout(r, 0));
    try {
      const { sql, appliedRules } = convertDialect(input, rules);
      if (appliedRules.length === 0) {
        setError("未检测到可转换的 MySQL 语法");
        return;
      }
      setResult({
        sql,
        meta: `已应用 ${appliedRules.length} 条规则：${appliedRules.join("、")}`,
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
          label: "输入 SQL（≤ 10 MB）",
          children: (
            <div className="space-y-2">
              <SqlEditor
                value={input}
                onChange={(v) => { setInput(v); setResult(null); setError(null); }}
                largeFile={null}
                onLargeFile={() => {}}
                placeholder="粘贴 MySQL DDL / DML，将转换为 PostgreSQL 语法..."
              />
              <p className="text-xs text-muted-foreground">
                方言转换仅支持粘贴文本（小文件），大文件请先拆分
              </p>
            </div>
          ),
        },
        {
          number: 2,
          label: "转换规则",
          children: (
            <div className="space-y-3">
              <p className="text-xs text-muted-foreground">
                转换方向：MySQL → PostgreSQL。勾选要应用的规则：
              </p>
              <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                {rules.map((rule) => (
                  <label
                    key={rule.id}
                    className="flex items-start gap-2 cursor-pointer group"
                  >
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={() => toggleRule(rule.id)}
                      className="accent-indigo-500 mt-0.5"
                    />
                    <div>
                      <span className="text-sm">{rule.label}</span>
                      <p className="text-xs text-muted-foreground font-mono">
                        {rule.description}
                      </p>
                    </div>
                  </label>
                ))}
              </div>

              <div className="flex items-center gap-3">
                <Button
                  onClick={handleExecute}
                  disabled={!hasInput || processing}
                  className="bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white shadow-md shadow-indigo-500/20"
                >
                  {processing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                  {processing ? "处理中..." : "执行转换"}
                </Button>
                {error && <p className="text-xs text-destructive">{error}</p>}
              </div>
            </div>
          ),
        },
        {
          number: 3,
          label: "查看结果",
          children: result ? (
            <ResultPanel content={result.sql} meta={result.meta} />
          ) : (
            <p className="text-sm text-muted-foreground">执行后结果将显示在这里...</p>
          ),
        },
      ]}
    />
  );
}

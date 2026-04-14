import { useState } from "react";
import { StepFlow } from "@/components/StepFlow";
import { SqlEditor } from "@/components/SqlEditor";
import { ResultPanel } from "@/components/ResultPanel";
import { Button } from "@/components/ui/button";
import { splitSQL } from "@/lib/sql/split";

export function Split() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState<{ sql: string; meta: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleExecute() {
    setError(null);
    try {
      const { sql, statementCount } = splitSQL(input);
      if (!sql) { setError("未识别到有效的批量 INSERT 语句"); return; }
      setResult({ sql, meta: `共拆分出 ${statementCount} 条语句` });
    } catch (e) {
      setError(`处理失败: ${e}`);
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
              onChange={setInput}
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
                disabled={!input.trim()}
                className="bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white shadow-md shadow-indigo-500/20"
              >
                执行拆分
              </Button>
              {error && <p className="text-xs text-destructive">{error}</p>}
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

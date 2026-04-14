import { useState } from "react";
import { StepFlow } from "@/components/StepFlow";
import { SqlEditor } from "@/components/SqlEditor";
import { ResultPanel } from "@/components/ResultPanel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mergeSQL } from "@/lib/sql/merge";

export function Merge() {
  const [input, setInput] = useState("");
  const [batchSize, setBatchSize] = useState(1000);
  const [result, setResult] = useState<{ sql: string; meta: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  function handleExecute() {
    setError(null);
    try {
      const { sql, tableCount, statementCount } = mergeSQL(input, { batchSize });
      if (!sql) { setError("未识别到有效的 INSERT 语句"); return; }
      setResult({ sql, meta: `共处理 ${tableCount} 张表，生成 ${statementCount} 条语句` });
    } catch (e) {
      setError(`处理失败: ${e}`);
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
              onChange={setInput}
              placeholder="粘贴多条 INSERT INTO 语句，或拖拽 .sql / .txt 文件..."
            />
          ),
        },
        {
          number: 2,
          label: "配置参数",
          children: (
            <div className="flex items-center gap-3 flex-wrap">
              <Label className="text-sm whitespace-nowrap">每批条数</Label>
              <Input
                type="number"
                value={batchSize}
                min={1}
                onChange={(e) => setBatchSize(Math.max(1, Number(e.target.value)))}
                className="w-28 font-mono"
              />
              <Button
                onClick={handleExecute}
                disabled={!input.trim()}
                className="bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white shadow-md shadow-indigo-500/20"
              >
                执行合并
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

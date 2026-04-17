import { useState } from "react";
import { StepFlow } from "@/components/StepFlow";
import { SqlEditor, type LargeFileInfo } from "@/components/SqlEditor";
import { ResultPanel } from "@/components/ResultPanel";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DIALECT_OPTIONS, type SqlDialect, type FormatResult } from "@/lib/sql/format";
import { useSqlWorker } from "@/hooks/useSqlWorker";

export function Format() {
  const [input, setInput] = useState("");
  const [largeFile, setLargeFile] = useState<LargeFileInfo | null>(null);
  const [dialect, setDialect] = useState<SqlDialect>("mysql");
  const [indent, setIndent] = useState<2 | 4>(2);
  const [result, setResult] = useState<{ sql: string; meta?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const { call } = useSqlWorker();
  const hasInput = !!input.trim() || !!largeFile;

  async function handleExecute() {
    // sql-formatter requires full content in memory — refuse files >10 MB
    if (largeFile) {
      setError("格式化不支持超过 10 MB 的文件，建议先用「分割」切分后逐段格式化");
      return;
    }
    setError(null);
    setProcessing(true);
    try {
      const { sql, success, warning } = await call<FormatResult>("format", { sql: input, options: { dialect, indent } });
      setResult({ sql, meta: warning });
      if (!success) console.warn(warning);
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
              onChange={setInput}
              largeFile={largeFile}
              onLargeFile={setLargeFile}
              placeholder="粘贴任意 SQL 语句，或拖拽文件..."
            />
          ),
        },
        {
          number: 2,
          label: "配置参数",
          children: (
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-2">
                <Label className="text-sm whitespace-nowrap">方言</Label>
                <Select
                  value={dialect}
                  onValueChange={(v) => setDialect(v as SqlDialect)}
                >
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {DIALECT_OPTIONS.map(({ value, label }) => (
                      <SelectItem key={value} value={value}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-2">
                <Label className="text-sm whitespace-nowrap">缩进</Label>
                <Select
                  value={String(indent)}
                  onValueChange={(v) => setIndent(Number(v) as 2 | 4)}
                >
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="2">2 空格</SelectItem>
                    <SelectItem value="4">4 空格</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                onClick={handleExecute}
                disabled={!hasInput || processing}
                className="bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white shadow-md shadow-indigo-500/20"
              >
                {processing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                {processing ? "处理中..." : "执行格式化"}
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

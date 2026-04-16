import { useState } from "react";
import { StepFlow } from "@/components/StepFlow";
import { SqlEditor } from "@/components/SqlEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Loader2 } from "lucide-react";
import { type DiffRow, type DiffStatus, type DiffResult } from "@/lib/sql/diff";
import { useSqlWorker } from "@/hooks/useSqlWorker";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<DiffStatus, string> = {
  added: "bg-green-500/10 border-green-500/30 text-green-400",
  removed: "bg-red-500/10 border-red-500/30 text-red-400",
  modified: "bg-yellow-500/10 border-yellow-500/30 text-yellow-400",
  unchanged: "bg-transparent border-border/30 text-muted-foreground",
};

const STATUS_LABEL: Record<DiffStatus, string> = {
  added: "新增",
  removed: "删除",
  modified: "修改",
  unchanged: "未变",
};

function DiffRowCard({ row }: { row: DiffRow }) {
  const cols = row.columns ?? [];

  return (
    <div
      className={cn(
        "rounded-md border px-3 py-2 text-xs font-mono space-y-1",
        STATUS_STYLE[row.status]
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "text-[10px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded",
            STATUS_STYLE[row.status]
          )}
        >
          {STATUS_LABEL[row.status]}
        </span>
        <span className="text-foreground">{row.tableName}</span>
        <span className="text-muted-foreground">key={row.keyValue}</span>
      </div>

      {row.status === "modified" && row.leftValues && row.rightValues && (
        <div className="space-y-0.5 pl-2 border-l border-current/30">
          {row.changedColumns.map((col) => {
            const idx = cols.findIndex((c) => c === col);
            const leftVal = idx !== -1 ? (row.leftValues![idx] ?? "—") : "—";
            const rightVal = idx !== -1 ? (row.rightValues![idx] ?? "—") : "—";
            return (
              <div key={col} className="flex gap-2">
                <span className="text-muted-foreground w-24 truncate">{col}:</span>
                <span className="text-red-400 line-through">{leftVal}</span>
                <span className="text-muted-foreground">→</span>
                <span className="text-green-400">{rightVal}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Diff() {
  const [leftSql, setLeftSql] = useState("");
  const [rightSql, setRightSql] = useState("");
  const [keyColumn, setKeyColumn] = useState("");
  const [useColumnName, setUseColumnName] = useState(true);
  const [keyColIndex, setKeyColIndex] = useState("1");
  const [showUnchanged, setShowUnchanged] = useState(false);

  const [rows, setRows] = useState<DiffRow[] | null>(null);
  const [summary, setSummary] = useState<{
    added: number; removed: number; modified: number; unchanged: number;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const { call } = useSqlWorker();

  const canExecute =
    !!leftSql.trim() &&
    !!rightSql.trim() &&
    !processing &&
    (useColumnName ? keyColumn.trim() !== "" : parseInt(keyColIndex, 10) >= 1);

  async function handleDiff() {
    setError(null);
    setRows(null);
    setSummary(null);
    setProcessing(true);
    try {
      const result = await call<DiffResult>("diff", {
        leftSql,
        rightSql,
        keyColumn: useColumnName ? keyColumn.trim() : undefined,
        keyColIndex: useColumnName ? undefined : parseInt(keyColIndex, 10),
      });
      setRows(result.rows);
      setSummary({
        added: result.addedCount,
        removed: result.removedCount,
        modified: result.modifiedCount,
        unchanged: result.unchangedCount,
      });
    } catch (e) {
      setError(`对比失败: ${e}`);
    } finally {
      setProcessing(false);
    }
  }

  const visibleRows = rows?.filter(
    (r) => showUnchanged || r.status !== "unchanged"
  );

  return (
    <StepFlow
      steps={[
        {
          number: 1,
          label: "Left / Right SQL（各 ≤ 10 MB）",
          children: (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Left（旧）</p>
                  <SqlEditor
                    value={leftSql}
                    onChange={(v) => { setLeftSql(v); setRows(null); }}
                    largeFile={null}
                    onLargeFile={() => {}}
                    placeholder="粘贴旧版 SQL..."
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground">Right（新）</p>
                  <SqlEditor
                    value={rightSql}
                    onChange={(v) => { setRightSql(v); setRows(null); }}
                    largeFile={null}
                    onLargeFile={() => {}}
                    placeholder="粘贴新版 SQL..."
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                SQL Diff 仅支持粘贴文本（小文件），大文件建议用数据库工具对比
              </p>
            </div>
          ),
        },
        {
          number: 2,
          label: "对比配置",
          children: (
            <div className="space-y-4">
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">主键列</p>
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
                    列序号
                  </label>
                </div>
                {useColumnName ? (
                  <Input
                    value={keyColumn}
                    onChange={(e) => setKeyColumn(e.target.value)}
                    placeholder="例如：id"
                    className="font-mono text-sm max-w-xs"
                  />
                ) : (
                  <Input
                    type="number"
                    min={1}
                    value={keyColIndex}
                    onChange={(e) => setKeyColIndex(e.target.value)}
                    className="font-mono text-sm max-w-[120px]"
                  />
                )}
              </div>

              <div className="flex items-center gap-3">
                <Button
                  onClick={handleDiff}
                  disabled={!canExecute}
                  className="bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white shadow-md shadow-indigo-500/20"
                >
                  {processing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                  {processing ? "对比中..." : "执行对比"}
                </Button>
                {error && <p className="text-xs text-destructive">{error}</p>}
              </div>
            </div>
          ),
        },
        {
          number: 3,
          label: "对比结果",
          children: summary ? (
            <div className="space-y-3">
              {/* Summary */}
              <div className="flex gap-4 flex-wrap">
                {[
                  { label: "新增", count: summary.added, color: "text-green-400" },
                  { label: "删除", count: summary.removed, color: "text-red-400" },
                  { label: "修改", count: summary.modified, color: "text-yellow-400" },
                  { label: "未变", count: summary.unchanged, color: "text-muted-foreground" },
                ].map(({ label, count, color }) => (
                  <div key={label} className="text-center">
                    <p className={cn("text-xl font-semibold", color)}>{count}</p>
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
                  </div>
                ))}
              </div>

              <label className="flex items-center gap-1.5 text-xs cursor-pointer text-muted-foreground">
                <input
                  type="checkbox"
                  checked={showUnchanged}
                  onChange={(e) => setShowUnchanged(e.target.checked)}
                  className="accent-indigo-500"
                />
                显示未变行
              </label>

              <div className="space-y-1.5 max-h-96 overflow-y-auto pr-1">
                {visibleRows?.length === 0 ? (
                  <p className="text-sm text-muted-foreground">无差异</p>
                ) : (
                  visibleRows?.map((row, i) => (
                    <DiffRowCard key={i} row={row} />
                  ))
                )}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">对比后结果将显示在这里...</p>
          ),
        },
      ]}
    />
  );
}

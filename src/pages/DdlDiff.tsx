import { useState } from "react";
import { StepFlow } from "@/components/StepFlow";
import { ResultPanel } from "@/components/ResultPanel";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Plus, Minus, Pencil, CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  parseDDL,
  diffDDL,
  generateAlterSql,
  type DdlDialect,
  type DdlDiffResult,
  type ColumnChange,
  type IndexChange,
} from "@/lib/sql/ddl_diff";

// ─── Types ────────────────────────────────────────────────────────────────────

const DIALECT_OPTIONS: { value: DdlDialect; label: string }[] = [
  { value: "mysql",      label: "MySQL" },
  { value: "postgresql", label: "PostgreSQL" },
  { value: "oracle",     label: "Oracle" },
];

const KIND_STYLE: Record<ColumnChange["kind"], string> = {
  added:    "bg-green-500/10 border-green-500/30 text-green-400",
  removed:  "bg-red-500/10 border-red-500/30 text-red-400",
  modified: "bg-yellow-500/10 border-yellow-500/30 text-yellow-400",
};

const KIND_LABEL: Record<ColumnChange["kind"], string> = {
  added:    "新增",
  removed:  "删除",
  modified: "修改",
};

const KIND_ICON: Record<ColumnChange["kind"], React.ComponentType<{ className?: string }>> = {
  added:    Plus,
  removed:  Minus,
  modified: Pencil,
};

// ─── Sub-components ───────────────────────────────────────────────────────────

function ChangeTag({ kind }: { kind: ColumnChange["kind"] }) {
  const Icon = KIND_ICON[kind];
  return (
    <span className={cn(
      "inline-flex items-center gap-0.5 text-[9px] uppercase tracking-wider font-semibold px-1.5 py-0.5 rounded border",
      KIND_STYLE[kind]
    )}>
      <Icon className="w-2.5 h-2.5" />
      {KIND_LABEL[kind]}
    </span>
  );
}

function ColumnChangeCard({ change }: { change: ColumnChange }) {
  return (
    <div className={cn(
      "rounded-md border px-3 py-2 text-xs font-mono space-y-1",
      KIND_STYLE[change.kind]
    )}>
      <div className="flex items-center gap-2 flex-wrap">
        <ChangeTag kind={change.kind} />
        <span className="text-foreground font-semibold">{change.column.rawName}</span>
        {change.kind === "modified" && change.fromColumn && (
          <span className="text-muted-foreground text-[10px]">（字段）</span>
        )}
      </div>
      {change.kind === "modified" && change.fromColumn && (
        <div className="pl-2 border-l border-current/30 space-y-0.5">
          <div className="flex gap-2 items-start">
            <span className="text-red-400 line-through break-all">{change.fromColumn.fullDef}</span>
          </div>
          <div className="flex gap-2 items-start">
            <span className="text-green-400 break-all">{change.column.fullDef}</span>
          </div>
        </div>
      )}
      {change.kind !== "modified" && (
        <div className="pl-2 border-l border-current/30 text-muted-foreground break-all">
          {change.column.fullDef}
        </div>
      )}
    </div>
  );
}

function IndexChangeCard({ change }: { change: IndexChange }) {
  const idx = change.index;
  return (
    <div className={cn(
      "rounded-md border px-3 py-2 text-xs font-mono space-y-1",
      KIND_STYLE[change.kind]
    )}>
      <div className="flex items-center gap-2 flex-wrap">
        <ChangeTag kind={change.kind} />
        <span className="text-foreground font-semibold">{idx.rawName}</span>
        <span className="text-muted-foreground text-[10px]">
          {idx.type} ({idx.columns.join(", ")})
        </span>
      </div>
      {change.kind === "modified" && change.fromIndex && (
        <div className="pl-2 border-l border-current/30 space-y-0.5 text-muted-foreground">
          <div><span className="text-red-400 line-through">{change.fromIndex.columns.join(", ")}</span></div>
          <div><span className="text-green-400">{change.index.columns.join(", ")}</span></div>
        </div>
      )}
    </div>
  );
}

function DiffSummary({ diff }: { diff: DdlDiffResult }) {
  const addedCols    = diff.columnChanges.filter((c) => c.kind === "added").length;
  const removedCols  = diff.columnChanges.filter((c) => c.kind === "removed").length;
  const modifiedCols = diff.columnChanges.filter((c) => c.kind === "modified").length;
  const addedIdx     = diff.indexChanges.filter((c) => c.kind === "added").length;
  const removedIdx   = diff.indexChanges.filter((c) => c.kind === "removed").length;
  const modifiedIdx  = diff.indexChanges.filter((c) => c.kind === "modified").length;

  const stats = [
    { label: "字段新增", count: addedCols,    color: "text-green-400" },
    { label: "字段删除", count: removedCols,   color: "text-red-400" },
    { label: "字段修改", count: modifiedCols,  color: "text-yellow-400" },
    { label: "索引新增", count: addedIdx,      color: "text-green-400" },
    { label: "索引删除", count: removedIdx,    color: "text-red-400" },
    { label: "索引修改", count: modifiedIdx,   color: "text-yellow-400" },
  ].filter((s) => s.count > 0);

  if (stats.length === 0) {
    return (
      <div className="flex items-center gap-2 text-green-400 text-sm">
        <CheckCircle2 className="w-4 h-4" />
        两张表结构完全相同，无差异
      </div>
    );
  }

  return (
    <div className="flex gap-4 flex-wrap">
      {stats.map(({ label, count, color }) => (
        <div key={label} className="text-center">
          <p className={cn("text-xl font-semibold", color)}>{count}</p>
          <p className="text-[10px] uppercase tracking-widest text-muted-foreground">{label}</p>
        </div>
      ))}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function DdlDiff() {
  const [srcDdl, setSrcDdl]               = useState("");
  const [dstDdl, setDstDdl]               = useState("");
  const [dialect, setDialect]             = useState<DdlDialect>("mysql");
  const [includeIndexes, setIncludeIndexes] = useState(true);

  const [diffResult, setDiffResult]       = useState<DdlDiffResult | null>(null);
  const [alterSql, setAlterSql]           = useState<string>("");
  const [error, setError]                 = useState<string | null>(null);
  const [processing, setProcessing]       = useState(false);

  const canExecute = !!srcDdl.trim() && !!dstDdl.trim() && !processing;

  function handleExecute() {
    setError(null);
    setDiffResult(null);
    setAlterSql("");
    setProcessing(true);

    // Synchronous but wrapped in try/catch + setTimeout to keep UI responsive
    setTimeout(() => {
      try {
        const srcDef = parseDDL(srcDdl);
        const dstDef = parseDDL(dstDdl);
        // diff(dst, src): "what does dst need to become src"
        // → src has col but dst doesn't = dst needs to ADD it
        const diff   = diffDDL(dstDef, srcDef, includeIndexes);
        // ALTER TABLE targets the destination table (the one being modified)
        const sql    = diff.hasChanges ? generateAlterSql(diff, dialect, dstDef.rawTableName) : "";
        setDiffResult(diff);
        setAlterSql(sql);
      } catch (e) {
        setError(String(e));
      } finally {
        setProcessing(false);
      }
    }, 0);
  }

  const metaText = diffResult
    ? diffResult.hasChanges
      ? `字段变更 ${diffResult.columnChanges.length} 项，索引变更 ${diffResult.indexChanges.length} 项`
      : "两表结构完全相同"
    : undefined;

  return (
    <StepFlow
      steps={[
        // ── Step 1: Input ────────────────────────────────────────────────────
        {
          number: 1,
          label: "输入两张表的 DDL（CREATE TABLE）",
          children: (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    源表 DDL（基准）
                  </p>
                  <Textarea
                    value={srcDdl}
                    onChange={(e) => { setSrcDdl(e.target.value); setDiffResult(null); }}
                    placeholder={"CREATE TABLE `users` (\n  `id` INT NOT NULL AUTO_INCREMENT,\n  `name` VARCHAR(100),\n  `email` VARCHAR(255),\n  PRIMARY KEY (`id`)\n);"}
                    className="font-mono text-xs min-h-[200px] resize-y"
                  />
                </div>
                <div className="space-y-1">
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground">
                    目标表 DDL（待修改）
                  </p>
                  <Textarea
                    value={dstDdl}
                    onChange={(e) => { setDstDdl(e.target.value); setDiffResult(null); }}
                    placeholder={"CREATE TABLE `users` (\n  `id` INT NOT NULL AUTO_INCREMENT,\n  `name` VARCHAR(100),\n  PRIMARY KEY (`id`)\n);"}
                    className="font-mono text-xs min-h-[200px] resize-y"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                对比目标表与源表的差异，生成让目标表与源表一致所需的 ALTER SQL。每个输入框只支持单张表 DDL。
              </p>
            </div>
          ),
        },

        // ── Step 2: Config ───────────────────────────────────────────────────
        {
          number: 2,
          label: "对比配置",
          children: (
            <div className="space-y-4">
              {/* Dialect selector */}
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-muted-foreground">目标方言（生成的 ALTER SQL 语法）</p>
                <div className="flex gap-3">
                  {DIALECT_OPTIONS.map(({ value, label }) => (
                    <label key={value} className="flex items-center gap-1.5 text-sm cursor-pointer">
                      <input
                        type="radio"
                        name="dialect"
                        checked={dialect === value}
                        onChange={() => setDialect(value)}
                        className="accent-indigo-500"
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </div>

              {/* Index diff toggle */}
              <label className="flex items-center gap-2 cursor-pointer text-sm">
                <input
                  type="checkbox"
                  checked={includeIndexes}
                  onChange={(e) => setIncludeIndexes(e.target.checked)}
                  className="accent-indigo-500"
                />
                对比索引变更（PRIMARY KEY、UNIQUE、INDEX）
              </label>

              <div className="flex items-center gap-3">
                <Button
                  onClick={handleExecute}
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

        // ── Step 3: Result ───────────────────────────────────────────────────
        {
          number: 3,
          label: "对比结果 & 生成 ALTER SQL",
          children: diffResult ? (
            <div className="space-y-4">
              {/* Summary */}
              <DiffSummary diff={diffResult} />

              {diffResult.hasChanges && (
                <>
                  {/* Column changes */}
                  {diffResult.columnChanges.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
                        字段变更（{diffResult.columnChanges.length}）
                      </p>
                      <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
                        {diffResult.columnChanges.map((change, i) => (
                          <ColumnChangeCard key={i} change={change} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Index changes */}
                  {diffResult.indexChanges.length > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
                        索引变更（{diffResult.indexChanges.length}）
                      </p>
                      <div className="space-y-1.5">
                        {diffResult.indexChanges.map((change, i) => (
                          <IndexChangeCard key={i} change={change} />
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Generated ALTER SQL */}
                  <div className="space-y-1.5">
                    <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-medium">
                      生成的 ALTER SQL
                      <span className="ml-2 normal-case text-muted-foreground/70">
                        （方言：{DIALECT_OPTIONS.find((d) => d.value === dialect)?.label}）
                      </span>
                    </p>
                    <ResultPanel content={alterSql} meta={metaText} />
                  </div>
                </>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">执行对比后结果将显示在这里...</p>
          ),
        },
      ]}
    />
  );
}

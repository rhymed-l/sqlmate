import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { StepFlow } from "@/components/StepFlow";
import { SqlEditor, type LargeFileInfo } from "@/components/SqlEditor";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { analyzeSql, formatBytes, statsToMarkdown, statsToCsv, type SqlStats } from "@/lib/sql/stats";
import { useStreamProgress } from "@/hooks/useStreamProgress";
import { ProgressBar } from "@/components/ProgressBar";

interface RustStats {
  tables: { table_name: string; row_count: number; estimated_bytes: number }[];
  total_rows: number;
  total_statements: number;
  input_bytes: number;
  duration_ms: number;
}

function normalizeStats(raw: RustStats | SqlStats): SqlStats {
  if ("tables" in raw && raw.tables.length > 0 && "table_name" in raw.tables[0]) {
    const r = raw as RustStats;
    return {
      tables: r.tables.map((t) => ({
        tableName: t.table_name,
        rowCount: t.row_count,
        estimatedBytes: t.estimated_bytes,
      })),
      totalRows: r.total_rows,
      totalStatements: r.total_statements,
      inputBytes: r.input_bytes,
      durationMs: r.duration_ms,
    };
  }
  return raw as SqlStats;
}

export function Stats() {
  const [input, setInput] = useState("");
  const [largeFile, setLargeFile] = useState<LargeFileInfo | null>(null);
  const [stats, setStats] = useState<SqlStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const { progress, startProgress } = useStreamProgress();
  const hasInput = !!input.trim() || !!largeFile;

  async function handleAnalyze() {
    setError(null);
    setStats(null);

    if (largeFile) {
      setProcessing(true);
      const stopProgress = await startProgress();
      try {
        const raw = await invoke<RustStats>("analyze_sql_file", {
          inputPath: largeFile.path,
        });
        setStats(normalizeStats(raw));
      } catch (e) {
        setError(`分析失败: ${e}`);
      } finally {
        stopProgress();
        setProcessing(false);
      }
      return;
    }

    setProcessing(true);
    await new Promise((r) => setTimeout(r, 0));
    try {
      const result = analyzeSql(input);
      setStats(result);
    } catch (e) {
      setError(`分析失败: ${e}`);
    } finally {
      setProcessing(false);
    }
  }

  function copyText(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
  }

  return (
    <StepFlow
      steps={[
        {
          number: 1,
          label: "输入 SQL",
          children: (
            <div className="space-y-3">
              <SqlEditor
                value={input}
                onChange={(v) => { setInput(v); setStats(null); setError(null); }}
                largeFile={largeFile}
                onLargeFile={(f) => { setLargeFile(f); setStats(null); setError(null); }}
                placeholder="粘贴包含 INSERT 语句的 SQL，或拖拽 .sql / .txt 文件..."
              />
              <div className="flex items-center gap-3">
                <Button
                  onClick={handleAnalyze}
                  disabled={!hasInput || processing}
                  className="bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white shadow-md shadow-indigo-500/20"
                >
                  {processing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                  {processing ? "分析中..." : "开始分析"}
                </Button>
                {error && <p className="text-xs text-destructive">{error}</p>}
                {progress !== null && largeFile && <ProgressBar percent={progress} />}
              </div>
            </div>
          ),
        },
        {
          number: 2,
          label: "统计结果",
          children: stats ? (
            <div className="space-y-4">
              {/* Summary bar */}
              <div className="flex gap-6 flex-wrap">
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground">总表数</p>
                  <p className="text-xl font-semibold">{stats.tables.length}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground">总行数</p>
                  <p className="text-xl font-semibold">{stats.totalRows.toLocaleString()}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground">文件大小</p>
                  <p className="text-xl font-semibold">{formatBytes(stats.inputBytes)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-muted-foreground">扫描耗时</p>
                  <p className="text-xl font-semibold">{stats.durationMs} ms</p>
                </div>
              </div>

              {/* Table */}
              {stats.tables.length > 0 && (
                <div className="overflow-auto rounded-lg border border-border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/40">
                      <tr>
                        <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">表名</th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">行数</th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">估算大小</th>
                      </tr>
                    </thead>
                    <tbody>
                      {stats.tables.map((t) => (
                        <tr key={t.tableName} className="border-t border-border/50">
                          <td className="px-3 py-1.5 font-mono text-xs">{t.tableName}</td>
                          <td className="px-3 py-1.5 text-right text-xs">{t.rowCount.toLocaleString()}</td>
                          <td className="px-3 py-1.5 text-right text-xs text-muted-foreground">
                            {formatBytes(t.estimatedBytes)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Export buttons */}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => copyText(statsToMarkdown(stats))}
                >
                  复制 Markdown
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => copyText(statsToCsv(stats))}
                >
                  复制 CSV
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">分析后结果将显示在这里...</p>
          ),
        },
      ]}
    />
  );
}

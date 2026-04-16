import { useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { StepFlow } from "@/components/StepFlow";
import { Button } from "@/components/ui/button";
import { CheckCircle, Loader2, FileText, Trash2, ArrowUp, ArrowDown, FolderOpen } from "lucide-react";
import { useStreamProgress } from "@/hooks/useStreamProgress";
import { ProgressBar } from "@/components/ProgressBar";

interface FileEntry {
  id: number;
  path: string;
  name: string;
}

let nextId = 1;

export function FileMerge() {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [dedupeSets, setDedupeSets] = useState(true);   // remove duplicate SET statements
  const [addSeparator, setAddSeparator] = useState(true); // insert file separator comment

  const [result, setResult] = useState<{
    totalLines: number;
    outputPath: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const { progress, startProgress } = useStreamProgress();

  const canExecute = files.length >= 2 && !processing;

  function addFiles() {
    open({
      multiple: true,
      filters: [{ name: "SQL / Text", extensions: ["sql", "txt"] }],
    }).then((selected) => {
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      setFiles((prev) => [
        ...prev,
        ...paths.map((p) => ({
          id: nextId++,
          path: p,
          name: p.replace(/\\/g, "/").split("/").pop() ?? p,
        })),
      ]);
    });
  }

  function removeFile(id: number) {
    setFiles((prev) => prev.filter((f) => f.id !== id));
  }

  function moveFile(idx: number, dir: -1 | 1) {
    setFiles((prev) => {
      const next = [...prev];
      const target = idx + dir;
      if (target < 0 || target >= next.length) return prev;
      [next[idx], next[target]] = [next[target], next[idx]];
      return next;
    });
  }

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const paths: string[] = [];
    for (const item of Array.from(e.dataTransfer.items)) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) paths.push(f.name); // Tauri exposes path via webkitGetAsEntry or similar
      }
    }
    // For Tauri apps drag-drop uses the Tauri event system — handled by invoke below
  }, []);

  async function handleExecute() {
    setError(null);
    setResult(null);

    const outputPath = await save({
      filters: [{ name: "SQL Files", extensions: ["sql"] }],
      defaultPath: "merged.sql",
    });
    if (!outputPath) return;

    setProcessing(true);
    const stopProgress = await startProgress();
    try {
      const stats = await invoke<{ total_lines: number }>("merge_sql_files", {
        inputPaths: files.map((f) => f.path),
        outputPath,
        dedupeSets,
        addSeparator,
      });
      setResult({ totalLines: stats.total_lines, outputPath });
    } catch (e) {
      setError(`处理失败: ${e}`);
    } finally {
      stopProgress();
      setProcessing(false);
    }
  }

  return (
    <StepFlow
      steps={[
        {
          number: 1,
          label: "选择文件",
          children: (
            <div
              className="space-y-3"
              onDragOver={(e) => e.preventDefault()}
              onDrop={handleDrop}
            >
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={addFiles}>
                  <FolderOpen className="w-3.5 h-3.5 mr-1.5" />
                  添加文件
                </Button>
                {files.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setFiles([])}
                    className="text-muted-foreground text-xs"
                  >
                    清空
                  </Button>
                )}
              </div>

              {files.length === 0 ? (
                <p className="text-sm text-muted-foreground py-2">
                  选择 2 个或以上 .sql / .txt 文件，合并顺序可拖拽调整
                </p>
              ) : (
                <div className="space-y-1 max-h-60 overflow-y-auto pr-1">
                  {files.map((f, idx) => (
                    <div
                      key={f.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-muted/40 border border-border/50 group"
                    >
                      <FileText className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="flex-1 text-xs font-mono truncate" title={f.path}>
                        {f.name}
                      </span>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => moveFile(idx, -1)}
                          disabled={idx === 0}
                          className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        >
                          <ArrowUp className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => moveFile(idx, 1)}
                          disabled={idx === files.length - 1}
                          className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                        >
                          <ArrowDown className="w-3 h-3" />
                        </button>
                        <button
                          onClick={() => removeFile(f.id)}
                          className="text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ),
        },
        {
          number: 2,
          label: "合并选项",
          children: (
            <div className="space-y-4">
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={addSeparator}
                    onChange={(e) => setAddSeparator(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  在每个文件之间插入分隔注释
                  <span className="text-xs text-muted-foreground font-mono">
                    -- === file: xxx.sql ===
                  </span>
                </label>
                <label className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={dedupeSets}
                    onChange={(e) => setDedupeSets(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  去除重复 SET 语句
                  <span className="text-xs text-muted-foreground font-mono">
                    SET NAMES utf8mb4 只保留一次
                  </span>
                </label>
              </div>

              <div className="flex items-center gap-3">
                <Button
                  onClick={handleExecute}
                  disabled={!canExecute}
                  className="bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white shadow-md shadow-indigo-500/20"
                >
                  {processing && <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />}
                  {processing ? "合并中..." : "选择保存位置并合并"}
                </Button>
                {error && <p className="text-xs text-destructive">{error}</p>}
                {progress !== null && <ProgressBar percent={progress} />}
              </div>
            </div>
          ),
        },
        {
          number: 3,
          label: "查看结果",
          children: result ? (
            <div className="flex items-start gap-3 p-4 rounded-lg bg-green-500/10 border border-green-500/20">
              <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <p className="text-sm font-medium">合并完成</p>
                <p className="text-xs text-muted-foreground">
                  共 {files.length} 个文件，{result.totalLines.toLocaleString()} 行
                </p>
                <p className="text-xs text-muted-foreground font-mono break-all">
                  {result.outputPath}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">合并后结果将显示在这里...</p>
          ),
        },
      ]}
    />
  );
}

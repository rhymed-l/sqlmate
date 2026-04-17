import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { StepFlow } from "@/components/StepFlow";
import { SqlEditor, type LargeFileInfo } from "@/components/SqlEditor";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { segmentSQL, type SegmentMode } from "@/lib/sql/segment";
import { CheckCircle, FolderOpen, Loader2 } from "lucide-react";
import { useStreamProgress } from "@/hooks/useStreamProgress";
import { ProgressBar } from "@/components/ProgressBar";

export function Segment() {
  const [input, setInput] = useState("");
  const [largeFile, setLargeFile] = useState<LargeFileInfo | null>(null);
  const [mode, setMode] = useState<SegmentMode>("count");
  const [count, setCount] = useState(10000);
  const [sizeMB, setSizeMB] = useState(10);
  const [status, setStatus] = useState<{ fileCount: number; folder: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  const { progress, startProgress } = useStreamProgress();
  const hasInput = !!input.trim() || !!largeFile;

  async function handleExecute() {
    setError(null);
    try {
      const folderPath = await open({ directory: true, title: "选择输出文件夹" });
      if (!folderPath || typeof folderPath !== "string") return;

      setProcessing(true);
      await new Promise((r) => setTimeout(r, 0));

      let fileCount: number;

      if (largeFile) {
        // Large file: Rust streaming — zero content passes through IPC
        const stopProgress = await startProgress();
        try {
          fileCount = await invoke<number>("segment_file", {
            inputPath: largeFile.path,
            outputFolder: folderPath,
            mode,
            value: mode === "count" ? count : sizeMB,
          });
        } finally {
          stopProgress();
        }
      } else {
        // Small file: JS processing
        const result = segmentSQL(input, { mode, count, sizeMB });
        fileCount = result.fileCount;
        await invoke("write_files_to_folder", {
          folder: folderPath,
          files: result.files.map((f) => [f.name, f.content]),
        });
      }

      setStatus({ fileCount, folder: folderPath });
    } catch (e) {
      setError(`操作失败: ${e}`);
    } finally {
      setProcessing(false);
    }
  }

  return (
    <StepFlow
      steps={[
        {
          number: 1,
          label: "输入 SQL 文件",
          children: (
            <SqlEditor
              value={input}
              onChange={setInput}
              largeFile={largeFile}
              onLargeFile={setLargeFile}
              placeholder="拖拽大 SQL 文件到此处，或点击选择文件..."
            />
          ),
        },
        {
          number: 2,
          label: "配置分割方式",
          children: (
            <div className="flex items-center gap-4 flex-wrap">
              <div className="flex items-center gap-2">
                <Label className="text-sm whitespace-nowrap">模式</Label>
                <Select value={mode} onValueChange={(v) => setMode(v as SegmentMode)}>
                  <SelectTrigger className="w-28">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="count">按条数</SelectItem>
                    <SelectItem value="size">按大小</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {mode === "count" ? (
                <div className="flex items-center gap-2">
                  <Label className="text-sm whitespace-nowrap">每文件条数</Label>
                  <Input
                    type="number"
                    value={count}
                    min={1}
                    onChange={(e) => setCount(Math.max(1, Number(e.target.value)))}
                    className="w-28 font-mono"
                  />
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Label className="text-sm whitespace-nowrap">每文件大小 (MB)</Label>
                  <Input
                    type="number"
                    value={sizeMB}
                    min={1}
                    onChange={(e) => setSizeMB(Math.max(1, Number(e.target.value)))}
                    className="w-24 font-mono"
                  />
                </div>
              )}
              <Button
                onClick={handleExecute}
                disabled={!hasInput || processing}
                className="bg-gradient-to-r from-indigo-500 to-violet-500 hover:from-indigo-600 hover:to-violet-600 text-white shadow-md shadow-indigo-500/20"
              >
                {processing ? (
                  <Loader2 className="w-4 h-4 mr-1.5 animate-spin" />
                ) : (
                  <FolderOpen className="w-4 h-4 mr-1.5" />
                )}
                {processing ? "处理中..." : "选择输出文件夹并执行"}
              </Button>
              {error && <p className="text-xs text-destructive">{error}</p>}
              {progress !== null && largeFile && (
                <ProgressBar percent={progress} />
              )}
            </div>
          ),
        },
        {
          number: 3,
          label: "分割结果",
          children: status ? (
            <div className="flex items-start gap-3 p-4 rounded-lg bg-green-500/10 border border-green-500/20">
              <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium">分割完成</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  共生成 {status.fileCount} 个文件
                </p>
                <p className="text-xs text-muted-foreground font-mono break-all mt-0.5">
                  {status.folder}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              执行后文件将直接保存到所选文件夹...
            </p>
          ),
        },
      ]}
    />
  );
}

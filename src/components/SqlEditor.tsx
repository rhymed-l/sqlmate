import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Upload, FileText } from "lucide-react";
import { cn } from "@/lib/utils";

export interface LargeFileInfo {
  path: string;
  name: string;
  sizeBytes: number;
}

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  /** Set when a file >10 MB was selected — content is NOT loaded into JS. */
  largeFile: LargeFileInfo | null;
  onLargeFile: (info: LargeFileInfo | null) => void;
  placeholder?: string;
}

const LARGE_FILE_THRESHOLD = 10 * 1024 * 1024; // 10 MB
const ALLOWED_EXTENSIONS = ["sql", "txt"];

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SqlEditor({
  value,
  onChange,
  largeFile,
  onLargeFile,
  placeholder,
}: SqlEditorProps) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingName, setLoadingName] = useState("");

  async function loadFromPath(path: string, name: string, sizeBytes?: number) {
    const size = sizeBytes ?? (await invoke<number>("file_size", { path }).catch(() => 0));

    if (size > LARGE_FILE_THRESHOLD) {
      // Large file: store path only, never load content into JS
      onChange("");
      onLargeFile({ path, name, sizeBytes: size });
      setError(null);
      return;
    }

    // Small file: load content normally
    setLoading(true);
    setLoadingName(name);
    setError(null);
    onLargeFile(null);
    try {
      const content = await invoke<string>("read_file", { path });
      onChange(content);
    } catch (e) {
      setError(`读取文件失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }

  async function handlePickFile() {
    const path = await open({
      filters: [{ name: "SQL Files", extensions: ALLOWED_EXTENSIONS }],
    });
    if (typeof path === "string") {
      const name = path.split(/[\\/]/).pop() ?? path;
      await loadFromPath(path, name);
    }
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setDragging(true);
  }

  function handleDragLeave() {
    setDragging(false);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      setError("仅支持 .sql / .txt 文件");
      return;
    }
    const nativePath = (file as unknown as { path?: string }).path;
    if (nativePath) {
      loadFromPath(nativePath, file.name, file.size);
    } else {
      // Fallback: FileReader (no size check possible — treat as small file)
      const reader = new FileReader();
      reader.onload = (ev) => {
        onChange(ev.target?.result as string);
        onLargeFile(null);
        setError(null);
      };
      reader.readAsText(file);
    }
  }

  function handleClear() {
    onChange("");
    onLargeFile(null);
    setError(null);
  }

  const lineCount = value ? value.split("\n").length : 0;
  const byteSize = value ? new TextEncoder().encode(value).length : 0;
  const showSizeBadge = byteSize > 10 * 1024;

  return (
    <div className="space-y-2">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          "rounded-lg border-2 border-dashed transition-colors",
          dragging
            ? "border-primary bg-primary/5"
            : "border-border hover:border-primary/40"
        )}
      >
        {loading ? (
          /* File is being read (small file) */
          <div className="h-40 flex flex-col items-center justify-center gap-3 px-4">
            <p className="text-sm text-muted-foreground truncate max-w-full">
              正在读取{" "}
              <span className="text-foreground font-medium">{loadingName}</span>…
            </p>
            <div className="w-48 h-1 bg-muted rounded-full overflow-hidden">
              <div className="h-full bg-primary rounded-full animate-file-load" />
            </div>
          </div>
        ) : largeFile ? (
          /* Large file path mode — content stays on disk */
          <div className="h-40 flex flex-col items-center justify-center gap-2 px-4">
            <div className="flex items-center gap-2 text-primary">
              <FileText className="w-5 h-5 flex-shrink-0" />
              <span className="text-sm font-medium truncate max-w-xs">
                {largeFile.name}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {formatSize(largeFile.sizeBytes)} · 大文件模式，内容不加载到内存
            </span>
          </div>
        ) : (
          /* Normal textarea */
          <Textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={
              placeholder ?? "粘贴 SQL 语句，或拖拽 .sql / .txt 文件到此处..."
            }
            className="h-40 font-mono text-sm border-0 bg-transparent resize-none focus-visible:ring-0"
          />
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handlePickFile}
          disabled={loading}
        >
          <Upload className="w-3.5 h-3.5 mr-1.5" />
          选择文件
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {showSizeBadge && !loading && !largeFile && (
          <span className="text-xs text-muted-foreground">
            {lineCount.toLocaleString()} 行 · {formatSize(byteSize)}
          </span>
        )}
        {(value || largeFile) && !loading && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            className="ml-auto text-muted-foreground text-xs"
          >
            清空
          </Button>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Upload } from "lucide-react";
import { cn } from "@/lib/utils";

interface SqlEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

const ALLOWED_EXTENSIONS = ["sql", "txt"];

export function SqlEditor({ value, onChange, placeholder }: SqlEditorProps) {
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadFromPath(path: string) {
    try {
      const content = await invoke<string>("read_file", { path });
      onChange(content);
      setError(null);
    } catch (e) {
      setError(`读取文件失败: ${e}`);
    }
  }

  async function handlePickFile() {
    const path = await open({
      filters: [{ name: "SQL Files", extensions: ALLOWED_EXTENSIONS }],
    });
    if (typeof path === "string") await loadFromPath(path);
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
    // Tauri provides the native file path on the dataTransfer object
    const nativePath = (file as unknown as { path?: string }).path;
    if (nativePath) {
      loadFromPath(nativePath);
    } else {
      // Fallback: read via FileReader (text content only, no large-file stream)
      const reader = new FileReader();
      reader.onload = (ev) => onChange(ev.target?.result as string);
      reader.readAsText(file);
      setError(null);
    }
  }

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
        <Textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={
            placeholder ??
            "粘贴 SQL 语句，或拖拽 .sql / .txt 文件到此处..."
          }
          className="min-h-[160px] font-mono text-sm border-0 bg-transparent resize-y focus-visible:ring-0"
        />
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={handlePickFile}>
          <Upload className="w-3.5 h-3.5 mr-1.5" />
          选择文件
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {value && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => { onChange(""); setError(null); }}
            className="ml-auto text-muted-foreground text-xs"
          >
            清空
          </Button>
        )}
      </div>
    </div>
  );
}

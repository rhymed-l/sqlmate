import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Copy, Download, CheckCheck, Info } from "lucide-react";

interface ResultPanelProps {
  content: string;
  meta?: string;
}

const PREVIEW_LINES = 100;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ResultPanel({ content, meta }: ResultPanelProps) {
  const [copied, setCopied] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const lines = content.split("\n");
  const isLarge = lines.length > PREVIEW_LINES;
  const displayContent = isLarge ? lines.slice(0, PREVIEW_LINES).join("\n") : content;
  const byteSize = new TextEncoder().encode(content).length;

  async function handleCopy() {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function handleSave() {
    setSaveError(null);
    try {
      const path = await save({
        filters: [{ name: "SQL Files", extensions: ["sql"] }],
        defaultPath: "output.sql",
      });
      if (path) await invoke("write_file", { path, content });
    } catch (e) {
      setSaveError(`保存失败: ${e}`);
    }
  }

  return (
    <div className="space-y-2">
      {meta && <p className="text-xs text-muted-foreground">{meta}</p>}
      <div className="rounded-lg border bg-muted/30 overflow-hidden">
        <pre className="p-4 font-mono text-xs overflow-x-hidden overflow-y-auto h-56 whitespace-pre-wrap break-all leading-relaxed">
          {displayContent}
        </pre>
        {isLarge && (
          <div className="px-4 py-2 border-t border-border bg-muted/50 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Info className="w-3 h-3 flex-shrink-0" />
            共 {lines.length.toLocaleString()} 行 · {formatSize(byteSize)} · 仅预览前 {PREVIEW_LINES} 行，完整内容请复制或保存文件
          </div>
        )}
      </div>
      {content && (
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleCopy}>
            {copied ? (
              <CheckCheck className="w-3.5 h-3.5 mr-1.5 text-green-500" />
            ) : (
              <Copy className="w-3.5 h-3.5 mr-1.5" />
            )}
            {copied ? "已复制" : "复制"}
          </Button>
          <Button variant="outline" size="sm" onClick={handleSave}>
            <Download className="w-3.5 h-3.5 mr-1.5" />
            保存文件
          </Button>
          {saveError && <p className="text-xs text-destructive">{saveError}</p>}
        </div>
      )}
    </div>
  );
}

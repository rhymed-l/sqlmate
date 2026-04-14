import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Copy, Download, CheckCheck } from "lucide-react";

interface ResultPanelProps {
  content: string;
  meta?: string;
}

export function ResultPanel({ content, meta }: ResultPanelProps) {
  const [copied, setCopied] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

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
      <div className="rounded-lg border bg-muted/30">
        <pre className="p-4 font-mono text-sm overflow-auto max-h-72 whitespace-pre-wrap break-words leading-relaxed">
          {content || (
            <span className="text-muted-foreground">执行后结果将显示在这里...</span>
          )}
        </pre>
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

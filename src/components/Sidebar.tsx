import {
  GitMerge, Scissors, Files, Sparkles, ArrowLeftRight, Filter,
  CopyMinus, Replace, MoveRight, BarChart2, RefreshCw,
  FolderGit2, Languages, GitCompare, ShieldOff,
  Sun, Moon
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useTheme } from "@/hooks/useTheme";

interface NavItem {
  id: string;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { id: "merge",       label: "合并",   Icon: GitMerge },
  { id: "split",       label: "拆分",   Icon: Scissors },
  { id: "segment",     label: "分割",   Icon: Files },
  { id: "format",      label: "格式化", Icon: Sparkles },
  { id: "extract",     label: "抽取",   Icon: Filter },
  { id: "convert",     label: "转换",   Icon: ArrowLeftRight },
  { id: "dedupe",      label: "去重",   Icon: CopyMinus },
  { id: "rename",      label: "替换",   Icon: Replace },
  { id: "offset",      label: "偏移",   Icon: MoveRight },
  { id: "stats",       label: "统计",   Icon: BarChart2 },
  { id: "convertstmt", label: "改写",   Icon: RefreshCw },
  { id: "filemerge",   label: "多合一", Icon: FolderGit2 },
  { id: "dialect",     label: "方言",   Icon: Languages },
  { id: "diff",        label: "Diff",   Icon: GitCompare },
  { id: "mask",        label: "脱敏",   Icon: ShieldOff },
];

interface SidebarProps {
  active: string;
  onNavigate: (id: string) => void;
}

export function Sidebar({ active, onNavigate }: SidebarProps) {
  const { theme, toggleTheme } = useTheme();

  return (
    <aside className="w-16 flex-shrink-0 flex flex-col items-center py-3 gap-1 bg-sidebar border-r border-border">
      {/* Logo */}
      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-400 to-violet-500 flex items-center justify-center mb-2 shadow-lg shadow-indigo-500/20">
        <span className="text-white font-bold text-sm">S</span>
      </div>

      {/* Nav — scrollable */}
      <nav className="flex flex-col gap-0.5 flex-1 w-full px-2 overflow-y-auto scrollbar-none">
        {NAV_ITEMS.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            title={label}
            className={cn(
              "w-full h-10 rounded-lg flex flex-col items-center justify-center gap-0.5 text-[9px] font-medium transition-all flex-shrink-0",
              active === id
                ? "bg-indigo-500/15 text-indigo-400 shadow-sm"
                : "text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </nav>

      {/* Theme toggle */}
      <button
        onClick={toggleTheme}
        title={theme === "dark" ? "切换浅色模式" : "切换深色模式"}
        className="w-12 h-9 rounded-lg flex items-center justify-center text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        {theme === "dark" ? (
          <Sun className="w-4 h-4" />
        ) : (
          <Moon className="w-4 h-4" />
        )}
      </button>
    </aside>
  );
}

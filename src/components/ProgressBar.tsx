interface ProgressBarProps {
  percent: number; // 0-100
}

export function ProgressBar({ percent }: ProgressBarProps) {
  return (
    <div className="flex items-center gap-3 flex-1 min-w-0">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-indigo-500 to-violet-500 rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums w-8 text-right">
        {percent}%
      </span>
    </div>
  );
}

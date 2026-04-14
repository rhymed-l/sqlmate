export type SegmentMode = "count" | "size";

export interface SegmentOptions {
  mode: SegmentMode;
  count?: number;
  sizeMB?: number;
}

export interface SegmentResult {
  files: { name: string; content: string }[];
  fileCount: number;
}

function fileName(index: number): string {
  return `output_${String(index).padStart(3, "0")}.sql`;
}

function parseStatements(sql: string): string[] {
  return sql
    .split(/;\s*\n?/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => s + ";");
}

export function segmentSQL(sql: string, options: SegmentOptions): SegmentResult {
  const statements = parseStatements(sql);
  const files: { name: string; content: string }[] = [];

  if (options.mode === "count") {
    const count = options.count ?? 10000;
    for (let i = 0; i < statements.length; i += count) {
      const chunk = statements.slice(i, i + count);
      files.push({ name: fileName(files.length + 1), content: chunk.join("\n") });
    }
  } else {
    const maxBytes = (options.sizeMB ?? 10) * 1024 * 1024;
    let current: string[] = [];
    let currentSize = 0;

    for (const stmt of statements) {
      const stmtSize = new TextEncoder().encode(stmt).length;
      if (currentSize + stmtSize > maxBytes && current.length > 0) {
        files.push({ name: fileName(files.length + 1), content: current.join("\n") });
        current = [];
        currentSize = 0;
      }
      current.push(stmt);
      currentSize += stmtSize;
    }
    if (current.length > 0) {
      files.push({ name: fileName(files.length + 1), content: current.join("\n") });
    }
  }

  return { files, fileCount: files.length };
}

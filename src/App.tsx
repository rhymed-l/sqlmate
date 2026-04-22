import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { Merge } from "@/pages/Merge";
import { Split } from "@/pages/Split";
import { Segment } from "@/pages/Segment";
import { Format } from "@/pages/Format";
import { Extract } from "@/pages/Extract";
import { Convert } from "@/pages/Convert";
import { Dedupe } from "@/pages/Dedupe";
import { Rename } from "@/pages/Rename";
import { Offset } from "@/pages/Offset";
import { Stats } from "@/pages/Stats";
import { ConvertStmt } from "@/pages/ConvertStmt";
import { FileMerge } from "@/pages/FileMerge";
import { Dialect } from "@/pages/Dialect";
import { Diff } from "@/pages/Diff";
import { Mask } from "@/pages/Mask";
import { DdlDiff } from "@/pages/DdlDiff";

type PageId =
  | "merge" | "split" | "segment" | "format" | "extract" | "convert"
  | "dedupe" | "rename" | "offset" | "stats" | "convertstmt"
  | "filemerge" | "dialect" | "diff" | "mask" | "ddldiff";

const PAGES: Record<PageId, React.ComponentType> = {
  merge: Merge,
  split: Split,
  segment: Segment,
  format: Format,
  extract: Extract,
  convert: Convert,
  dedupe: Dedupe,
  rename: Rename,
  offset: Offset,
  stats: Stats,
  convertstmt: ConvertStmt,
  filemerge: FileMerge,
  dialect: Dialect,
  diff: Diff,
  mask: Mask,
  ddldiff: DdlDiff,
};

export default function App() {
  const [page, setPage] = useState<PageId>("merge");
  const Page = PAGES[page];

  return (
    <div className="flex h-screen bg-background text-foreground overflow-hidden select-none">
      <Sidebar active={page} onNavigate={(id) => setPage(id as PageId)} />
      <main className="flex-1 overflow-y-auto">
        <Page />
      </main>
    </div>
  );
}

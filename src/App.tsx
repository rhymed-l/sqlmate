import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";
import { Merge } from "@/pages/Merge";
import { Split } from "@/pages/Split";
import { Segment } from "@/pages/Segment";
import { Format } from "@/pages/Format";
import { Convert } from "@/pages/Convert";

type PageId = "merge" | "split" | "segment" | "format" | "convert";

const PAGES: Record<PageId, React.ComponentType> = {
  merge: Merge,
  split: Split,
  segment: Segment,
  format: Format,
  convert: Convert,
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

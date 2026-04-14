// @vitest-environment node
import { describe, it, expect } from "vitest";
import { segmentSQL } from "./segment";

describe("segmentSQL - count mode", () => {
  it("splits 5 statements into 3 files with count=2", () => {
    const stmts = Array.from({ length: 5 }, (_, i) =>
      `INSERT INTO t (id) VALUES (${i + 1});`
    ).join("\n");

    const result = segmentSQL(stmts, { mode: "count", count: 2 });

    expect(result.fileCount).toBe(3);
    expect(result.files[0].name).toBe("output_001.sql");
    expect(result.files[1].name).toBe("output_002.sql");
    expect(result.files[2].name).toBe("output_003.sql");
  });

  it("puts all statements in one file when count >= total", () => {
    const stmts = "INSERT INTO t (id) VALUES (1);\nINSERT INTO t (id) VALUES (2);";
    const result = segmentSQL(stmts, { mode: "count", count: 100 });
    expect(result.fileCount).toBe(1);
  });
});

describe("segmentSQL - size mode", () => {
  it("splits into multiple files when size limit is tiny", () => {
    const stmts = [
      "INSERT INTO t (id) VALUES (1);",
      "INSERT INTO t (id) VALUES (2);",
    ].join("\n");

    // 0.00001 MB = ~10 bytes — each statement is larger so each gets its own file
    const result = segmentSQL(stmts, { mode: "size", sizeMB: 0.00001 });
    expect(result.fileCount).toBe(2);
  });

  it("keeps all content in one file when size is generous", () => {
    const stmts = "INSERT INTO t (id) VALUES (1);";
    const result = segmentSQL(stmts, { mode: "size", sizeMB: 100 });
    expect(result.fileCount).toBe(1);
  });
});

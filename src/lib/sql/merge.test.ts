// @vitest-environment node
import { describe, it, expect } from "vitest";
import { mergeSQL } from "./merge";

describe("mergeSQL", () => {
  it("merges multiple single-value INSERTs into one batch", () => {
    const input = [
      "INSERT INTO users (id, name) VALUES (1, 'Alice');",
      "INSERT INTO users (id, name) VALUES (2, 'Bob');",
      "INSERT INTO users (id, name) VALUES (3, 'Charlie');",
    ].join("\n");

    const result = mergeSQL(input, { batchSize: 1000 });

    expect(result.statementCount).toBe(1);
    expect(result.tableCount).toBe(1);
    expect(result.sql).toContain("(1, 'Alice')");
    expect(result.sql).toContain("(2, 'Bob')");
    expect(result.sql).toContain("(3, 'Charlie')");
  });

  it("splits into multiple batches when count exceeds batchSize", () => {
    const input = [
      "INSERT INTO t (id) VALUES (1);",
      "INSERT INTO t (id) VALUES (2);",
      "INSERT INTO t (id) VALUES (3);",
    ].join("\n");

    const result = mergeSQL(input, { batchSize: 2 });

    expect(result.statementCount).toBe(2);
  });

  it("keeps different tables separate", () => {
    const input = [
      "INSERT INTO users (id) VALUES (1);",
      "INSERT INTO orders (id) VALUES (100);",
    ].join("\n");

    const result = mergeSQL(input, { batchSize: 1000 });

    expect(result.tableCount).toBe(2);
    expect(result.statementCount).toBe(2);
  });

  it("returns empty string for empty input", () => {
    const result = mergeSQL("", { batchSize: 1000 });
    expect(result.sql).toBe("");
    expect(result.statementCount).toBe(0);
  });
});

// @vitest-environment node
import { describe, it, expect } from "vitest";
import { splitSQL } from "./split";

describe("splitSQL", () => {
  it("splits a batch INSERT into individual statements", () => {
    const input = "INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob'), (3, 'Charlie');";
    const result = splitSQL(input);

    expect(result.statementCount).toBe(3);
    expect(result.sql).toContain("VALUES (1, 'Alice');");
    expect(result.sql).toContain("VALUES (2, 'Bob');");
    expect(result.sql).toContain("VALUES (3, 'Charlie');");
  });

  it("handles single-value INSERT without splitting", () => {
    const input = "INSERT INTO users (id) VALUES (1);";
    const result = splitSQL(input);
    expect(result.statementCount).toBe(1);
  });

  it("handles multiple batch INSERT statements", () => {
    const input = [
      "INSERT INTO users (id) VALUES (1), (2);",
      "INSERT INTO orders (id) VALUES (100), (200);",
    ].join("\n");
    const result = splitSQL(input);
    expect(result.statementCount).toBe(4);
  });

  it("returns empty string for empty input", () => {
    const result = splitSQL("");
    expect(result.sql).toBe("");
    expect(result.statementCount).toBe(0);
  });
});

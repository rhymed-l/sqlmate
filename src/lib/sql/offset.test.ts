// @vitest-environment node
import { describe, it, expect } from "vitest";
import { offsetSql } from "./offset";

describe("offsetSql", () => {
  it("offsets a numeric column by column name", () => {
    const sql = "INSERT INTO `t` (`id`, `name`) VALUES (1, 'Alice');";
    const { sql: out, modifiedCount } = offsetSql(sql, [
      { column: "id", offset: 1000000 },
    ]);
    expect(out).toContain("VALUES (1000001, 'Alice')");
    expect(modifiedCount).toBe(1);
  });

  it("offsets multiple columns", () => {
    const sql =
      "INSERT INTO `t` (`id`, `parent_id`, `name`) VALUES (1, 0, 'root');";
    const { sql: out } = offsetSql(sql, [
      { column: "id", offset: 100 },
      { column: "parent_id", offset: 100 },
    ]);
    expect(out).toContain("VALUES (101, 100, 'root')");
  });

  it("supports negative offset", () => {
    const sql = "INSERT INTO `t` (`id`) VALUES (500);";
    const { sql: out } = offsetSql(sql, [{ column: "id", offset: -100 }]);
    expect(out).toContain("VALUES (400)");
  });

  it("offsets by column index (1-based) when no column list", () => {
    const sql = "INSERT INTO `t` VALUES (10, 'Alice');";
    const { sql: out, modifiedCount } = offsetSql(sql, [
      { column: "", colIndex: 1, offset: 5 },
    ]);
    expect(out).toContain("VALUES (15, 'Alice')");
    expect(modifiedCount).toBe(1);
  });

  it("skips non-numeric column values and records warning", () => {
    const sql = "INSERT INTO `t` (`id`) VALUES ('not-a-number');";
    const { modifiedCount, skippedCount, warnings } = offsetSql(sql, [
      { column: "id", offset: 1 },
    ]);
    expect(modifiedCount).toBe(0);
    expect(skippedCount).toBe(1);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("handles multiple rows — modifies all", () => {
    const sql =
      "INSERT INTO `t` (`id`) VALUES (1);\n" +
      "INSERT INTO `t` (`id`) VALUES (2);\n" +
      "INSERT INTO `t` (`id`) VALUES (3);";
    const { modifiedCount } = offsetSql(sql, [{ column: "id", offset: 10 }]);
    expect(modifiedCount).toBe(3);
  });

  it("preserves non-INSERT lines", () => {
    const sql = "-- comment\nINSERT INTO `t` (`id`) VALUES (1);";
    const { sql: out } = offsetSql(sql, [{ column: "id", offset: 1 }]);
    expect(out).toContain("-- comment");
  });

  it("returns unchanged sql when no rules", () => {
    const sql = "INSERT INTO `t` (`id`) VALUES (1);";
    const { sql: out, modifiedCount } = offsetSql(sql, []);
    expect(out).toBe(sql);
    expect(modifiedCount).toBe(0);
  });

  it("handles floating point offset result correctly", () => {
    const sql = "INSERT INTO `t` (`score`) VALUES (9);";
    const { sql: out } = offsetSql(sql, [{ column: "score", offset: 0 }]);
    expect(out).toContain("VALUES (9)");
  });

  it("column name matching is case-insensitive", () => {
    const sql = "INSERT INTO `t` (`ID`) VALUES (100);";
    const { sql: out } = offsetSql(sql, [{ column: "id", offset: 1 }]);
    expect(out).toContain("VALUES (101)");
  });
});

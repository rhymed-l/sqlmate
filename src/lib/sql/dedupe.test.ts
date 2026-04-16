// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseSqlValues, parseInsertLine, dedupeSql } from "./dedupe";

// ─── parseSqlValues ────────────────────────────────────────────────────────

describe("parseSqlValues", () => {
  it("parses simple unquoted values", () => {
    expect(parseSqlValues("1, 2, 3")).toEqual(["1", "2", "3"]);
  });

  it("parses single-quoted strings", () => {
    expect(parseSqlValues("'Alice', 'Bob'")).toEqual(["'Alice'", "'Bob'"]);
  });

  it("handles '' escaping inside strings", () => {
    expect(parseSqlValues("'O''Brien'")).toEqual(["'O''Brien'"]);
  });

  it("parses mixed quoted and unquoted", () => {
    expect(parseSqlValues("'Alice', 30, NULL")).toEqual(["'Alice'", "30", "NULL"]);
  });

  it("handles extra whitespace", () => {
    expect(parseSqlValues("  'a' ,  1  ")).toEqual(["'a'", "1"]);
  });
});

// ─── parseInsertLine ───────────────────────────────────────────────────────

describe("parseInsertLine", () => {
  it("parses INSERT with column list", () => {
    const result = parseInsertLine(
      "INSERT INTO `users` (`id`, `name`) VALUES (1, 'Alice');"
    );
    expect(result).not.toBeNull();
    expect(result!.tableName).toBe("users");
    expect(result!.columns).toEqual(["id", "name"]);
    expect(result!.values).toEqual(["1", "'Alice'"]);
  });

  it("parses INSERT without column list", () => {
    const result = parseInsertLine(
      "INSERT INTO `users` VALUES (1, 'Alice');"
    );
    expect(result).not.toBeNull();
    expect(result!.tableName).toBe("users");
    expect(result!.columns).toBeNull();
    expect(result!.values).toEqual(["1", "'Alice'"]);
  });

  it("returns null for non-INSERT lines", () => {
    expect(parseInsertLine("-- comment")).toBeNull();
    expect(parseInsertLine("SELECT * FROM t")).toBeNull();
    expect(parseInsertLine("")).toBeNull();
  });

  it("handles table name without backticks", () => {
    const result = parseInsertLine("INSERT INTO users VALUES (1, 'Alice');");
    expect(result).not.toBeNull();
    expect(result!.tableName).toBe("users");
  });
});

// ─── dedupeSql ────────────────────────────────────────────────────────────

describe("dedupeSql", () => {
  const twoRows =
    "INSERT INTO `users` (`id`, `name`) VALUES (1, 'Alice');\n" +
    "INSERT INTO `users` (`id`, `name`) VALUES (1, 'AliceUpdated');";

  it("keeps last occurrence by default (keepLast=true)", () => {
    const result = dedupeSql(twoRows, { keyColumn: "id" });
    expect(result.originalCount).toBe(2);
    expect(result.keptCount).toBe(1);
    expect(result.removedCount).toBe(1);
    expect(result.sql).toContain("'AliceUpdated'");
    expect(result.sql).not.toContain("'Alice'");
  });

  it("keeps first occurrence when keepLast=false", () => {
    const result = dedupeSql(twoRows, { keyColumn: "id", keepLast: false });
    expect(result.keptCount).toBe(1);
    expect(result.sql).toContain("'Alice'");
    expect(result.sql).not.toContain("'AliceUpdated'");
  });

  it("deduplicates by column index (1-based)", () => {
    const sql =
      "INSERT INTO `t` VALUES (1, 'first');\n" +
      "INSERT INTO `t` VALUES (1, 'second');";
    const result = dedupeSql(sql, { keyColIndex: 1 });
    expect(result.keptCount).toBe(1);
    expect(result.sql).toContain("'second'");
  });

  it("keeps all rows when all keys are unique", () => {
    const sql =
      "INSERT INTO `users` (`id`) VALUES (1);\n" +
      "INSERT INTO `users` (`id`) VALUES (2);\n" +
      "INSERT INTO `users` (`id`) VALUES (3);";
    const result = dedupeSql(sql, { keyColumn: "id" });
    expect(result.keptCount).toBe(3);
    expect(result.removedCount).toBe(0);
  });

  it("deduplicates per table (same key in different tables both kept)", () => {
    const sql =
      "INSERT INTO `a` (`id`) VALUES (1);\n" +
      "INSERT INTO `b` (`id`) VALUES (1);\n" +
      "INSERT INTO `a` (`id`) VALUES (1);";
    const result = dedupeSql(sql, { keyColumn: "id" });
    // table 'a' has duplicate → 1 removed; table 'b' has 1 row → kept
    expect(result.keptCount).toBe(2);
    expect(result.removedCount).toBe(1);
  });

  it("preserves non-INSERT lines", () => {
    const sql =
      "-- header comment\n" +
      "INSERT INTO `t` (`id`) VALUES (1);\n" +
      "INSERT INTO `t` (`id`) VALUES (1);\n" +
      "-- footer";
    const result = dedupeSql(sql, { keyColumn: "id" });
    expect(result.sql).toContain("-- header comment");
    expect(result.sql).toContain("-- footer");
    expect(result.keptCount).toBe(1);
  });

  it("returns empty sql and zero counts for empty input", () => {
    const result = dedupeSql("", { keyColumn: "id" });
    expect(result.sql).toBe("");
    expect(result.originalCount).toBe(0);
    expect(result.keptCount).toBe(0);
    expect(result.removedCount).toBe(0);
  });

  it("keeps all rows when no key is specified (no dedup possible)", () => {
    const sql =
      "INSERT INTO `t` VALUES (1, 'a');\n" +
      "INSERT INTO `t` VALUES (1, 'b');";
    // Without keyColumn or keyColIndex — no key extraction → all kept
    const result = dedupeSql(sql, {});
    expect(result.keptCount).toBe(2);
  });

  it("handles INSERTs without column list using keyColIndex", () => {
    const sql =
      "INSERT INTO `orders` VALUES (100, 'shipped');\n" +
      "INSERT INTO `orders` VALUES (100, 'delivered');\n" +
      "INSERT INTO `orders` VALUES (101, 'shipped');";
    const result = dedupeSql(sql, { keyColIndex: 1 });
    expect(result.keptCount).toBe(2);
    expect(result.removedCount).toBe(1);
    expect(result.sql).toContain("'delivered'");
  });

  it("handles single-quoted string keys with '' escaping", () => {
    const sql =
      "INSERT INTO `t` (`name`) VALUES ('O''Brien');\n" +
      "INSERT INTO `t` (`name`) VALUES ('O''Brien');";
    const result = dedupeSql(sql, { keyColumn: "name" });
    expect(result.keptCount).toBe(1);
  });

  it("column name matching is case-insensitive", () => {
    const sql =
      "INSERT INTO `t` (`ID`) VALUES (1);\n" +
      "INSERT INTO `t` (`ID`) VALUES (1);";
    const result = dedupeSql(sql, { keyColumn: "id" });
    expect(result.keptCount).toBe(1);
  });
});

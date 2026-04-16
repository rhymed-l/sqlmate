// @vitest-environment node
import { describe, it, expect } from "vitest";
import { analyzeSql, statsToMarkdown, statsToCsv } from "./stats";

describe("analyzeSql", () => {
  it("counts rows per table", () => {
    const sql =
      "INSERT INTO `users` VALUES (1);\n" +
      "INSERT INTO `users` VALUES (2);\n" +
      "INSERT INTO `orders` VALUES (10);";
    const stats = analyzeSql(sql);
    const users = stats.tables.find((t) => t.tableName === "users");
    const orders = stats.tables.find((t) => t.tableName === "orders");
    expect(users?.rowCount).toBe(2);
    expect(orders?.rowCount).toBe(1);
    expect(stats.totalStatements).toBe(3);
    expect(stats.totalRows).toBe(3);
  });

  it("skips non-INSERT lines", () => {
    const sql = "-- comment\nSELECT * FROM t;\nINSERT INTO `t` VALUES (1);";
    const stats = analyzeSql(sql);
    expect(stats.totalStatements).toBe(1);
  });

  it("returns empty tables for empty input", () => {
    const stats = analyzeSql("");
    expect(stats.tables).toHaveLength(0);
    expect(stats.totalStatements).toBe(0);
  });

  it("handles unquoted table names", () => {
    const sql = "INSERT INTO users VALUES (1);";
    const stats = analyzeSql(sql);
    expect(stats.tables[0].tableName).toBe("users");
  });

  it("records estimated bytes > 0 for each table", () => {
    const sql = "INSERT INTO `t` (`id`) VALUES (1);";
    const stats = analyzeSql(sql);
    expect(stats.tables[0].estimatedBytes).toBeGreaterThan(0);
  });

  it("records inputBytes", () => {
    const sql = "INSERT INTO `t` VALUES (1);";
    const stats = analyzeSql(sql);
    expect(stats.inputBytes).toBeGreaterThan(0);
  });
});

describe("statsToMarkdown", () => {
  it("produces a markdown table with header", () => {
    const sql = "INSERT INTO `users` VALUES (1);";
    const stats = analyzeSql(sql);
    const md = statsToMarkdown(stats);
    expect(md).toContain("| 表名");
    expect(md).toContain("users");
  });
});

describe("statsToCsv", () => {
  it("produces csv with header and data rows", () => {
    const sql = "INSERT INTO `users` VALUES (1);";
    const stats = analyzeSql(sql);
    const csv = statsToCsv(stats);
    expect(csv).toContain("table_name,row_count");
    expect(csv).toContain("users,1");
  });
});

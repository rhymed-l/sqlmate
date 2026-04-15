// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseInsertToRows, toCsv } from "./export";

describe("parseInsertToRows", () => {
  it("extracts column names and rows from INSERT with column list", () => {
    const sql = "INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob');";
    const [table] = parseInsertToRows(sql);
    expect(table.tableName).toBe("users");
    expect(table.columns).toEqual(["id", "name"]);
    expect(table.rows).toEqual([["1", "Alice"], ["2", "Bob"]]);
  });

  it("generates col1/col2 names when INSERT has no column list", () => {
    const sql = "INSERT INTO users VALUES (1, 'Alice');";
    const [table] = parseInsertToRows(sql);
    expect(table.columns).toEqual(["col1", "col2"]);
    expect(table.rows[0]).toEqual(["1", "Alice"]);
  });

  it("converts NULL to empty string", () => {
    const sql = "INSERT INTO t (a, b) VALUES (1, NULL);";
    const [table] = parseInsertToRows(sql);
    expect(table.rows[0][1]).toBe("");
  });

  it("handles multiple tables", () => {
    const sql = [
      "INSERT INTO users (id) VALUES (1);",
      "INSERT INTO orders (id) VALUES (10);",
    ].join("\n");
    const tables = parseInsertToRows(sql);
    expect(tables).toHaveLength(2);
    expect(tables.map((t) => t.tableName)).toContain("users");
    expect(tables.map((t) => t.tableName)).toContain("orders");
  });

  it("strips backticks from table and column names", () => {
    const sql = "INSERT INTO `user_info` (`id`, `full_name`) VALUES (1, 'Alice');";
    const [table] = parseInsertToRows(sql);
    expect(table.tableName).toBe("user_info");
    expect(table.columns).toEqual(["id", "full_name"]);
  });

  it("unescapes SQL string values", () => {
    const sql = "INSERT INTO t (v) VALUES ('it''s a test');";
    const [table] = parseInsertToRows(sql);
    expect(table.rows[0][0]).toBe("it's a test");
  });

  it("accumulates rows across multiple INSERT statements for same table", () => {
    const sql = [
      "INSERT INTO t (id) VALUES (1);",
      "INSERT INTO t (id) VALUES (2);",
    ].join("\n");
    const [table] = parseInsertToRows(sql);
    expect(table.rows).toHaveLength(2);
  });

  it("correctly parses rows where string values contain parentheses", () => {
    const sql = "INSERT INTO t (v) VALUES ('open (paren'), ('normal');";
    const [table] = parseInsertToRows(sql);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0][0]).toBe("open (paren");
    expect(table.rows[1][0]).toBe("normal");
  });

  it("handles CRLF line endings in input SQL", () => {
    const sql = "INSERT INTO t (id) VALUES (1);\r\nINSERT INTO t (id) VALUES (2);";
    const [table] = parseInsertToRows(sql);
    expect(table.rows).toHaveLength(2);
  });

  it("treats differently-cased table names as separate tables", () => {
    const sql = [
      "INSERT INTO Users (id) VALUES (1);",
      "INSERT INTO users (id) VALUES (2);",
    ].join("\n");
    const tables = parseInsertToRows(sql);
    expect(tables).toHaveLength(2); // case-sensitive accumulation
  });
});

describe("toCsv", () => {
  it("generates header + data rows separated by CRLF", () => {
    const table = { tableName: "t", columns: ["id", "name"], rows: [["1", "Alice"]] };
    expect(toCsv(table)).toBe("id,name\r\n1,Alice");
  });

  it("wraps values containing commas in double quotes", () => {
    const table = { tableName: "t", columns: ["v"], rows: [["a,b"]] };
    expect(toCsv(table)).toContain('"a,b"');
  });

  it("escapes internal double quotes as double-double-quote", () => {
    const table = { tableName: "t", columns: ["v"], rows: [['say "hi"']] };
    expect(toCsv(table)).toContain('"say ""hi"""');
  });

  it("wraps values containing newlines in double quotes", () => {
    const table = { tableName: "t", columns: ["v"], rows: [["line1\nline2"]] };
    expect(toCsv(table)).toContain('"line1\nline2"');
  });
});

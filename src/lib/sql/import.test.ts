// @vitest-environment node
import { describe, it, expect } from "vitest";
import { csvToSql } from "./import";

describe("csvToSql", () => {
  it("generates INSERT statements with column list from header row", () => {
    const csv = "name,age\nAlice,30\nBob,25";
    const sql = csvToSql(csv, "users");
    const lines = sql.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      "INSERT INTO `users` (`name`, `age`) VALUES ('Alice', '30');"
    );
    expect(lines[1]).toBe(
      "INSERT INTO `users` (`name`, `age`) VALUES ('Bob', '25');"
    );
  });

  it("maps empty cell to NULL", () => {
    const csv = "name,age\nAlice,";
    const sql = csvToSql(csv, "users");
    expect(sql).toBe(
      "INSERT INTO `users` (`name`, `age`) VALUES ('Alice', NULL);"
    );
  });

  it("escapes single quotes in values", () => {
    const csv = "note\nit's a test";
    const sql = csvToSql(csv, "notes");
    expect(sql).toContain("'it''s a test'");
  });

  it("handles quoted fields with embedded commas", () => {
    const csv = 'city,desc\nNYC,"Big, Apple"';
    const sql = csvToSql(csv, "places");
    expect(sql).toContain("('NYC', 'Big, Apple')");
  });

  it("handles quoted fields with double-quote escaping (RFC 4180)", () => {
    const csv = 'note\n"say ""hello"""';
    const sql = csvToSql(csv, "t");
    expect(sql).toContain(`'say "hello"'`);
  });

  it("returns empty string when csv has fewer than 2 rows", () => {
    expect(csvToSql("name,age", "users")).toBe("");
    expect(csvToSql("", "users")).toBe("");
  });

  it("handles CRLF line endings", () => {
    const csv = "name,age\r\nAlice,30\r\nBob,25";
    const sql = csvToSql(csv, "users");
    expect(sql.split("\n")).toHaveLength(2);
  });

  it("skips blank rows", () => {
    const csv = "name\nAlice\n\nBob";
    const sql = csvToSql(csv, "t");
    expect(sql.split("\n")).toHaveLength(2);
  });

  it("strips backtick characters from column headers", () => {
    const csv = "`name`,`age`\nAlice,30";
    const sql = csvToSql(csv, "users");
    // backticks in header stripped then re-added: `name`, `age`
    expect(sql).toContain("(`name`, `age`)");
  });

  it("strips UTF-8 BOM from first column header", () => {
    // Excel often saves CSV with a leading BOM character
    const csv = "\uFEFFname,age\nAlice,30";
    const sql = csvToSql(csv, "users");
    expect(sql).toContain("(`name`, `age`)"); // BOM stripped, not part of column name
  });

  it("preserves text 'NULL' as string, only empty cell becomes SQL NULL", () => {
    const csv = "val\nNULL\n";
    const sql = csvToSql(csv, "t");
    expect(sql).toContain("'NULL'"); // text NULL → quoted string
  });
});

// @vitest-environment node
import { describe, it, expect } from "vitest";
import { csvToSql } from "./import";

describe("csvToSql", () => {
  // ─── Core INSERT generation ───────────────────────────────────────────────

  it("generates INSERT statements with column list from header row", () => {
    const csv = "name,age\nAlice,30\nBob,25";
    const sql = csvToSql(csv, { tableName: "users" });
    const lines = sql.split("\n");
    expect(lines).toHaveLength(2);
    // age column is all-numeric → no quotes
    expect(lines[0]).toBe(
      "INSERT INTO `users` (`name`, `age`) VALUES ('Alice', 30);"
    );
    expect(lines[1]).toBe(
      "INSERT INTO `users` (`name`, `age`) VALUES ('Bob', 25);"
    );
  });

  it("maps empty cell to NULL", () => {
    const csv = "name,age\nAlice,";
    const sql = csvToSql(csv, { tableName: "users" });
    expect(sql).toBe(
      "INSERT INTO `users` (`name`, `age`) VALUES ('Alice', NULL);"
    );
  });

  it("escapes single quotes in values", () => {
    const csv = "note\nit's a test";
    const sql = csvToSql(csv, { tableName: "notes" });
    expect(sql).toContain("'it''s a test'");
  });

  it("handles quoted fields with embedded commas", () => {
    const csv = 'city,desc\nNYC,"Big, Apple"';
    const sql = csvToSql(csv, { tableName: "places" });
    expect(sql).toContain("('NYC', 'Big, Apple')");
  });

  it("handles quoted fields with double-quote escaping (RFC 4180)", () => {
    const csv = 'note\n"say ""hello"""';
    const sql = csvToSql(csv, { tableName: "t" });
    expect(sql).toContain(`'say "hello"'`);
  });

  it("returns empty string when csv has fewer than 2 rows", () => {
    expect(csvToSql("name,age", { tableName: "users" })).toBe("");
    expect(csvToSql("", { tableName: "users" })).toBe("");
  });

  it("handles CRLF line endings", () => {
    const csv = "name,age\r\nAlice,30\r\nBob,25";
    const sql = csvToSql(csv, { tableName: "users" });
    expect(sql.split("\n")).toHaveLength(2);
  });

  it("skips blank rows", () => {
    const csv = "name\nAlice\n\nBob";
    const sql = csvToSql(csv, { tableName: "t" });
    expect(sql.split("\n")).toHaveLength(2);
  });

  it("strips backtick characters from column headers", () => {
    const csv = "`name`,`age`\nAlice,30";
    const sql = csvToSql(csv, { tableName: "users" });
    expect(sql).toContain("(`name`, `age`)");
  });

  it("strips UTF-8 BOM from first column header", () => {
    const csv = "\uFEFFname,age\nAlice,30";
    const sql = csvToSql(csv, { tableName: "users" });
    expect(sql).toContain("(`name`, `age`)");
  });

  it("preserves text 'NULL' as string, only empty cell becomes SQL NULL", () => {
    const csv = "val\nNULL\n";
    const sql = csvToSql(csv, { tableName: "t" });
    expect(sql).toContain("'NULL'");
  });

  // ─── Numeric detection ────────────────────────────────────────────────────

  it("omits quotes for all-numeric columns (detectNumeric default)", () => {
    const csv = "id,name,score\n1,Alice,9.5\n2,Bob,8.0";
    const sql = csvToSql(csv, { tableName: "results" });
    // id and score are numeric; name is not
    expect(sql).toContain("VALUES (1, 'Alice', 9.5)");
    expect(sql).toContain("VALUES (2, 'Bob', 8.0)");
  });

  it("quotes all values when detectNumeric is false", () => {
    const csv = "id,score\n1,9.5";
    const sql = csvToSql(csv, { tableName: "t", detectNumeric: false });
    expect(sql).toContain("('1', '9.5')");
  });

  it("treats mixed-type column as string (one non-numeric value prevents detection)", () => {
    const csv = "val\n1\n2\nthree";
    const sql = csvToSql(csv, { tableName: "t" });
    // 'three' makes the column non-numeric → all values quoted
    expect(sql).toContain("('1')");
    expect(sql).toContain("('three')");
  });

  // ─── noHeader option ─────────────────────────────────────────────────────

  it("uses col1/col2 headers when noHeader=true", () => {
    const csv = "Alice,30\nBob,25";
    const sql = csvToSql(csv, { tableName: "users", noHeader: true });
    expect(sql).toContain("(`col1`, `col2`)");
    expect(sql).toContain("('Alice',");
    expect(sql).toContain("('Bob',");
  });

  it("returns empty string for noHeader with empty input", () => {
    expect(csvToSql("", { tableName: "t", noHeader: true })).toBe("");
  });

  // ─── batchSize option ─────────────────────────────────────────────────────

  it("generates batch INSERT when batchSize > 0", () => {
    const csv = "id,val\n1,a\n2,b\n3,c";
    const sql = csvToSql(csv, {
      tableName: "t",
      batchSize: 2,
      detectNumeric: false,
    });
    // 3 rows with batchSize=2 → 2 INSERT statements
    const insertCount = (sql.match(/INSERT INTO/g) ?? []).length;
    expect(insertCount).toBe(2);
    // First batch has 2 rows
    expect(sql).toContain("('1', 'a'),");
    expect(sql).toContain("('2', 'b');");
    // Second batch has 1 row
    expect(sql).toContain("('3', 'c');");
  });

  it("single batchSize=1 behaves like single-row mode", () => {
    const csv = "x\n1\n2";
    const single = csvToSql(csv, { tableName: "t", batchSize: 0 });
    const batch1 = csvToSql(csv, { tableName: "t", batchSize: 1 });
    // Both should produce 2 INSERT statements
    const singleCount = (single.match(/INSERT INTO/g) ?? []).length;
    const batchCount = (batch1.match(/INSERT INTO/g) ?? []).length;
    expect(singleCount).toBe(2);
    expect(batchCount).toBe(2);
  });

  // ─── tableName sanitization ───────────────────────────────────────────────

  it("strips backticks from tableName to prevent injection", () => {
    const csv = "col\nval";
    const sql = csvToSql(csv, { tableName: "my`table" });
    expect(sql).toContain("INSERT INTO `mytable`");
  });
});

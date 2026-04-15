// @vitest-environment node
import { describe, it, expect } from "vitest";
import { scanTables, extractTables } from "./extract";

describe("scanTables", () => {
  it("counts INSERT statements per table", () => {
    const sql = [
      "INSERT INTO users (id) VALUES (1);",
      "INSERT INTO users (id) VALUES (2);",
      "INSERT INTO orders (id) VALUES (10);",
    ].join("\n");
    const result = scanTables(sql);
    const users = result.find((r) => r.name === "users");
    const orders = result.find((r) => r.name === "orders");
    expect(users?.count).toBe(2);
    expect(orders?.count).toBe(1);
  });

  it("normalizes backtick and schema prefix", () => {
    const sql = "INSERT INTO `mydb`.`user_info` (id) VALUES (1);";
    const result = scanTables(sql);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("user_info");
  });

  it("is case-insensitive", () => {
    const sql = [
      "INSERT INTO Users (id) VALUES (1);",
      "INSERT INTO USERS (id) VALUES (2);",
    ].join("\n");
    const result = scanTables(sql);
    expect(result).toHaveLength(1);
    expect(result[0].count).toBe(2);
  });

  it("returns empty array for no INSERT statements", () => {
    expect(scanTables("-- just a comment\nSELECT 1;")).toEqual([]);
  });
});

describe("extractTables", () => {
  it("keeps only statements for selected tables", () => {
    const sql = [
      "INSERT INTO users (id) VALUES (1);",
      "INSERT INTO orders (id) VALUES (10);",
      "INSERT INTO users (id) VALUES (2);",
    ].join("\n");
    const { sql: result, count } = extractTables(sql, ["users"]);
    expect(result).toContain("INSERT INTO users");
    expect(result).not.toContain("INSERT INTO orders");
    expect(count).toBe(2); // exactly 2 users statements
    const lines = result.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it("is case-insensitive on table names", () => {
    const sql = "INSERT INTO Users (id) VALUES (1);";
    const { sql: result } = extractTables(sql, ["users"]);
    expect(result).toContain("INSERT INTO Users");
  });

  it("strips backticks when matching", () => {
    const sql = "INSERT INTO `user_info` (id) VALUES (1);";
    const { sql: result } = extractTables(sql, ["user_info"]);
    expect(result).toContain("INSERT INTO `user_info`");
  });

  it("returns empty string when no tables match", () => {
    const sql = "INSERT INTO users (id) VALUES (1);";
    const { sql: result, count } = extractTables(sql, ["orders"]);
    expect(result).toBe("");
    expect(count).toBe(0);
  });

  it("handles multi-line statements (semicolon on last line)", () => {
    const sql = [
      "INSERT INTO users (id, name) VALUES",
      "(1, 'Alice');",
    ].join("\n");
    const { sql: result } = extractTables(sql, ["users"]);
    expect(result).toContain("INSERT INTO users");
    expect(result).toContain("'Alice'"); // body preserved
  });
});

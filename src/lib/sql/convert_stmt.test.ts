// @vitest-environment node
import { describe, it, expect } from "vitest";
import { convertStatements } from "./convert_stmt";

const baseInsert =
  "INSERT INTO `users` (`id`, `name`, `email`) VALUES (1, 'Alice', 'a@x.com');";

describe("convertStatements — UPDATE mode", () => {
  it("generates UPDATE with WHERE clause", () => {
    const { sql, convertedCount } = convertStatements(baseInsert, {
      mode: "update",
      pkColumn: "id",
    });
    expect(sql).toMatch(/^UPDATE `users` SET/);
    expect(sql).toContain("WHERE `id` = 1");
    expect(sql).toContain("`name` = 'Alice'");
    expect(sql).toContain("`email` = 'a@x.com'");
    expect(convertedCount).toBe(1);
  });

  it("excludes specified columns from SET", () => {
    const { sql } = convertStatements(baseInsert, {
      mode: "update",
      pkColumn: "id",
      excludeColumns: ["email"],
    });
    expect(sql).not.toContain("`email`");
    expect(sql).toContain("`name`");
  });

  it("skips INSERTs without column list (can't build SET)", () => {
    const sql = "INSERT INTO `t` VALUES (1, 'x');";
    const { skippedCount, convertedCount } = convertStatements(sql, {
      mode: "update",
      pkColumn: "id",
    });
    expect(skippedCount).toBe(1);
    expect(convertedCount).toBe(0);
  });

  it("skips when pk column not found", () => {
    const { skippedCount } = convertStatements(baseInsert, {
      mode: "update",
      pkColumn: "nonexistent",
    });
    expect(skippedCount).toBe(1);
  });

  it("converts multiple rows", () => {
    const sql =
      "INSERT INTO `t` (`id`, `v`) VALUES (1, 'a');\n" +
      "INSERT INTO `t` (`id`, `v`) VALUES (2, 'b');";
    const { convertedCount } = convertStatements(sql, {
      mode: "update",
      pkColumn: "id",
    });
    expect(convertedCount).toBe(2);
  });
});

describe("convertStatements — mysql_upsert mode", () => {
  it("generates ON DUPLICATE KEY UPDATE", () => {
    const { sql } = convertStatements(baseInsert, {
      mode: "mysql_upsert",
      pkColumn: "id",
    });
    expect(sql).toContain("ON DUPLICATE KEY UPDATE");
    expect(sql).toContain("`name` = VALUES(`name`)");
    expect(sql).toContain("`email` = VALUES(`email`)");
    expect(sql).not.toContain("`id` = VALUES(`id`)"); // pk not in UPDATE
  });

  it("supports INSERT without column list", () => {
    const sql = "INSERT INTO `t` VALUES (1, 'x');";
    const { convertedCount } = convertStatements(sql, {
      mode: "mysql_upsert",
      pkColIndex: 1,
    });
    expect(convertedCount).toBe(1);
  });
});

describe("convertStatements — pg_upsert mode", () => {
  it("generates ON CONFLICT DO UPDATE SET", () => {
    const { sql } = convertStatements(baseInsert, {
      mode: "pg_upsert",
      pkColumn: "id",
    });
    expect(sql).toContain('ON CONFLICT ("id") DO UPDATE SET');
    expect(sql).toContain('"name" = EXCLUDED."name"');
    expect(sql).toContain('"email" = EXCLUDED."email"');
    expect(sql).not.toContain('"id" = EXCLUDED'); // pk not in UPDATE
  });
});

describe("convertStatements — general", () => {
  it("preserves non-INSERT lines", () => {
    const sql = "-- comment\n" + baseInsert;
    const { sql: out } = convertStatements(sql, {
      mode: "update",
      pkColumn: "id",
    });
    expect(out).toContain("-- comment");
  });

  it("returns original when pkColumn not specified", () => {
    const { skippedCount } = convertStatements(baseInsert, { mode: "update" });
    expect(skippedCount).toBe(1);
  });
});

describe("convertStatements — insert_ignore mode", () => {
  it("injects IGNORE keyword", () => {
    const { sql, convertedCount } = convertStatements(baseInsert, { mode: "insert_ignore" });
    expect(sql).toBe(
      "INSERT IGNORE INTO `users` (`id`, `name`, `email`) VALUES (1, 'Alice', 'a@x.com');"
    );
    expect(convertedCount).toBe(1);
  });

  it("handles mixed case INSERT INTO", () => {
    const line = "insert into `t` (`a`) VALUES (1);";
    const { sql } = convertStatements(line, { mode: "insert_ignore" });
    expect(sql).toMatch(/^INSERT IGNORE INTO/);
  });

  it("preserves non-INSERT lines", () => {
    const mixed = "-- comment\n" + baseInsert;
    const { sql, convertedCount } = convertStatements(mixed, { mode: "insert_ignore" });
    expect(sql).toContain("-- comment");
    expect(convertedCount).toBe(1);
  });

  it("does not require pkColumn", () => {
    const { convertedCount, skippedCount } = convertStatements(baseInsert, { mode: "insert_ignore" });
    expect(convertedCount).toBe(1);
    expect(skippedCount).toBe(0);
  });
});

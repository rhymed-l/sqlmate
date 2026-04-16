// @vitest-environment node
import { describe, it, expect } from "vitest";
import { renameSql } from "./rename";

describe("renameSql — table rename", () => {
  it("renames backtick-quoted table name", () => {
    const sql = "INSERT INTO `users` (`id`) VALUES (1);";
    const { sql: out, replacedCount } = renameSql(sql, [
      { type: "table", from: "users", to: "accounts" },
    ]);
    expect(out).toContain("INSERT INTO `accounts`");
    expect(replacedCount).toBe(1);
  });

  it("renames unquoted table name", () => {
    const sql = "INSERT INTO users VALUES (1);";
    const { sql: out } = renameSql(sql, [
      { type: "table", from: "users", to: "accounts" },
    ]);
    expect(out).toContain("INSERT INTO `accounts`");
  });

  it("does not rename table name in VALUES section", () => {
    const sql = "INSERT INTO `users` (`name`) VALUES ('users');";
    const { sql: out } = renameSql(sql, [
      { type: "table", from: "users", to: "accounts" },
    ]);
    expect(out).toContain("INSERT INTO `accounts`");
    expect(out).toContain("('users')");
  });

  it("does not rename non-matching table", () => {
    const sql = "INSERT INTO `orders` (`id`) VALUES (1);";
    const { sql: out, replacedCount } = renameSql(sql, [
      { type: "table", from: "users", to: "accounts" },
    ]);
    expect(out).toContain("`orders`");
    expect(replacedCount).toBe(0);
  });

  it("renames across multiple lines", () => {
    const sql =
      "INSERT INTO `users` (`id`) VALUES (1);\n" +
      "INSERT INTO `orders` (`id`) VALUES (10);\n" +
      "INSERT INTO `users` (`id`) VALUES (2);";
    const { replacedCount } = renameSql(sql, [
      { type: "table", from: "users", to: "accounts" },
    ]);
    expect(replacedCount).toBe(2);
  });

  it("applies multiple rules sequentially", () => {
    const sql =
      "INSERT INTO `a` (`id`) VALUES (1);\n" +
      "INSERT INTO `b` (`id`) VALUES (2);";
    const { sql: out } = renameSql(sql, [
      { type: "table", from: "a", to: "alpha" },
      { type: "table", from: "b", to: "beta" },
    ]);
    expect(out).toContain("`alpha`");
    expect(out).toContain("`beta`");
  });

  it("preserves non-INSERT lines", () => {
    const sql = "-- comment\nINSERT INTO `users` VALUES (1);";
    const { sql: out } = renameSql(sql, [
      { type: "table", from: "users", to: "accounts" },
    ]);
    expect(out).toContain("-- comment");
  });

  it("returns zero replacedCount when no rules match", () => {
    const sql = "INSERT INTO `t` VALUES (1);";
    const { replacedCount } = renameSql(sql, []);
    expect(replacedCount).toBe(0);
  });
});

describe("renameSql — prefix rename", () => {
  it("replaces table name prefix", () => {
    const sql =
      "INSERT INTO `prod_users` (`id`) VALUES (1);\n" +
      "INSERT INTO `prod_orders` (`id`) VALUES (2);";
    const { sql: out, replacedCount } = renameSql(sql, [
      { type: "prefix", from: "prod_", to: "test_" },
    ]);
    expect(out).toContain("`test_users`");
    expect(out).toContain("`test_orders`");
    expect(replacedCount).toBe(2);
  });

  it("does not replace non-matching prefix", () => {
    const sql = "INSERT INTO `dev_users` VALUES (1);";
    const { sql: out, replacedCount } = renameSql(sql, [
      { type: "prefix", from: "prod_", to: "test_" },
    ]);
    expect(out).toContain("`dev_users`");
    expect(replacedCount).toBe(0);
  });
});

describe("renameSql — column rename", () => {
  it("renames a column in the column list", () => {
    const sql = "INSERT INTO `users` (`user_id`, `name`) VALUES (1, 'Alice');";
    const { sql: out, replacedCount } = renameSql(sql, [
      { type: "column", from: "user_id", to: "id" },
    ]);
    expect(out).toContain("`id`");
    expect(out).toContain("`name`");
    expect(out).toContain("VALUES (1, 'Alice')");
    expect(replacedCount).toBe(1);
  });

  it("does not rename column name if no column list in INSERT", () => {
    const sql = "INSERT INTO `t` VALUES (1, 'Alice');";
    const { sql: out, replacedCount } = renameSql(sql, [
      { type: "column", from: "id", to: "pk" },
    ]);
    // No column list → no replacement
    expect(replacedCount).toBe(0);
    expect(out).toBe(sql);
  });

  it("does not rename column in VALUES section", () => {
    const sql = "INSERT INTO `t` (`name`) VALUES ('name_col');";
    const { sql: out } = renameSql(sql, [
      { type: "column", from: "name", to: "label" },
    ]);
    expect(out).toContain("`label`");
    expect(out).toContain("('name_col')");
  });
});

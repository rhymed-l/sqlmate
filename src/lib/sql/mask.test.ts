// @vitest-environment node
import { describe, it, expect } from "vitest";
import { maskSql } from "./mask";

const baseInsert =
  "INSERT INTO `users` (`id`, `phone`, `email`, `name`) VALUES (1, '13912345678', 'alice@real.com', '张三');";

describe("maskSql", () => {
  it("masks phone column", () => {
    const { sql, maskedCount } = maskSql(baseInsert, [{ column: "phone", type: "phone" }]);
    expect(maskedCount).toBe(1);
    expect(sql).not.toContain("'13912345678'");
    expect(sql).toMatch(/'\d{11}'/); // 11-digit fake phone
  });

  it("masks email column", () => {
    const { sql } = maskSql(baseInsert, [{ column: "email", type: "email" }]);
    expect(sql).toContain("example.com");
    expect(sql).not.toContain("alice@real.com");
  });

  it("masks name column", () => {
    const { sql } = maskSql(baseInsert, [{ column: "name", type: "name" }]);
    expect(sql).not.toContain("'张三'");
  });

  it("masks id_card column", () => {
    const insert = "INSERT INTO `users` (`id`, `id_card`) VALUES (1, '110101199001011234');";
    const { sql } = maskSql(insert, [{ column: "id_card", type: "id_card" }]);
    expect(sql).not.toContain("'110101199001011234'");
    // 18-char ID card
    expect(sql).toMatch(/'[0-9X]{18}'/);
  });

  it("applies custom_mask", () => {
    const { sql } = maskSql(baseInsert, [{ column: "phone", type: "custom_mask", customValue: "***" }]);
    expect(sql).toContain("'***'");
  });

  it("applies regex_replace", () => {
    const { sql } = maskSql(baseInsert, [{
      column: "email",
      type: "regex_replace",
      regexPattern: "@.*$",
      regexReplace: "@hidden.com",
    }]);
    expect(sql).toContain("@hidden.com");
  });

  it("consistency: same original value → same fake value", () => {
    const twoRows =
      "INSERT INTO `users` (`id`, `phone`) VALUES (1, '13912345678');\n" +
      "INSERT INTO `users` (`id`, `phone`) VALUES (2, '13912345678');";
    const { sql } = maskSql(twoRows, [{ column: "phone", type: "phone" }]);
    const lines = sql.split("\n");
    const extract = (l: string) => l.match(/'(\d{11})'/)?.[1];
    expect(extract(lines[0])).toBe(extract(lines[1]));
  });

  it("warns when column not found", () => {
    const { warnings } = maskSql(baseInsert, [{ column: "nonexistent", type: "phone" }]);
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("skips INSERTs without column list", () => {
    const sql = "INSERT INTO `t` VALUES (1, '13912345678');";
    const { maskedCount } = maskSql(sql, [{ column: "phone", type: "phone" }]);
    expect(maskedCount).toBe(0);
  });

  it("preserves non-INSERT lines", () => {
    const sql = "-- comment\n" + baseInsert;
    const { sql: out } = maskSql(sql, [{ column: "phone", type: "phone" }]);
    expect(out).toContain("-- comment");
  });

  it("returns unchanged sql with zero rules", () => {
    const { maskedCount, sql: out } = maskSql(baseInsert, []);
    expect(maskedCount).toBe(0);
    expect(out).toBe(baseInsert);
  });
});

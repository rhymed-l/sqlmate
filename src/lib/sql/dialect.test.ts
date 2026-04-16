// @vitest-environment node
import { describe, it, expect } from "vitest";
import { buildDialectRules, convertDialect } from "./dialect";

describe("convertDialect — MySQL → PostgreSQL", () => {
  it("converts backticks to double quotes", () => {
    const rules = buildDialectRules();
    const { sql } = convertDialect("SELECT `id` FROM `users`", rules);
    expect(sql).toBe('SELECT "id" FROM "users"');
  });

  it("converts AUTO_INCREMENT to SERIAL", () => {
    const rules = buildDialectRules();
    const { sql } = convertDialect("id INT AUTO_INCREMENT", rules);
    expect(sql).toContain("SERIAL");
    expect(sql).not.toContain("AUTO_INCREMENT");
  });

  it("converts TINYINT(1) to BOOLEAN", () => {
    const rules = buildDialectRules();
    const { sql } = convertDialect("active TINYINT(1)", rules);
    expect(sql).toContain("BOOLEAN");
  });

  it("converts DATETIME to TIMESTAMP", () => {
    const rules = buildDialectRules();
    const { sql } = convertDialect("created_at DATETIME", rules);
    expect(sql).toContain("TIMESTAMP");
  });

  it("removes ENGINE= clause", () => {
    const rules = buildDialectRules();
    const { sql } = convertDialect("CREATE TABLE t () ENGINE=InnoDB", rules);
    expect(sql).not.toContain("ENGINE");
  });

  it("removes DEFAULT CHARSET clause", () => {
    const rules = buildDialectRules();
    const { sql } = convertDialect("CREATE TABLE t () DEFAULT CHARSET=utf8mb4", rules);
    expect(sql).not.toContain("CHARSET");
  });

  it("removes COLLATE clause", () => {
    const rules = buildDialectRules();
    const { sql } = convertDialect("name VARCHAR(100) COLLATE=utf8mb4_unicode_ci", rules);
    expect(sql).not.toContain("COLLATE");
  });

  it("removes UNSIGNED", () => {
    const rules = buildDialectRules();
    const { sql } = convertDialect("id INT UNSIGNED", rules);
    expect(sql).not.toContain("UNSIGNED");
  });

  it("reports applied rules", () => {
    const rules = buildDialectRules();
    const { appliedRules } = convertDialect("`t`", rules);
    expect(appliedRules.length).toBeGreaterThan(0);
  });

  it("skips disabled rules", () => {
    const rules = buildDialectRules().map((r) => ({ ...r, enabled: false }));
    const { sql } = convertDialect("`id`", rules);
    expect(sql).toBe("`id`"); // no change
  });
});

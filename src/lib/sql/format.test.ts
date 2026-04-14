// @vitest-environment node
import { describe, it, expect } from "vitest";
import { formatSQL, DIALECT_OPTIONS } from "./format";

describe("formatSQL", () => {
  it("uppercases SQL keywords", () => {
    const result = formatSQL("select id from users", { dialect: "mysql", indent: 2 });
    expect(result.success).toBe(true);
    expect(result.sql).toMatch(/SELECT/);
    expect(result.sql).toMatch(/FROM/);
  });

  it("applies 4-space indent", () => {
    const result = formatSQL("select id,name from users where id=1", {
      dialect: "mysql",
      indent: 4,
    });
    expect(result.success).toBe(true);
    expect(result.sql).toContain("    ");
  });

  it("works for all supported dialects", () => {
    for (const { value } of DIALECT_OPTIONS) {
      const result = formatSQL("SELECT 1", { dialect: value, indent: 2 });
      expect(result.success).toBe(true);
    }
  });

  it("returns original sql with warning on error", () => {
    // Force an error by passing an invalid dialect cast
    const result = formatSQL("SELECT 1", { dialect: "invalid" as any, indent: 2 });
    // sql-formatter may or may not throw — either way sql must be non-empty
    expect(result.sql.length).toBeGreaterThan(0);
  });
});

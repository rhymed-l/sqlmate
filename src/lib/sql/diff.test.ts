// @vitest-environment node
import { describe, it, expect } from "vitest";
import { diffSql } from "./diff";

const row1 = "INSERT INTO `users` (`id`, `name`) VALUES (1, 'Alice');";
const row2 = "INSERT INTO `users` (`id`, `name`) VALUES (2, 'Bob');";
const row1mod = "INSERT INTO `users` (`id`, `name`) VALUES (1, 'Alice2');";

describe("diffSql", () => {
  it("detects added rows (only in right)", () => {
    const result = diffSql("", row2, "id");
    expect(result.addedCount).toBe(1);
    expect(result.rows[0].status).toBe("added");
  });

  it("detects removed rows (only in left)", () => {
    const result = diffSql(row1, "", "id");
    expect(result.removedCount).toBe(1);
    expect(result.rows[0].status).toBe("removed");
  });

  it("detects modified rows", () => {
    const result = diffSql(row1, row1mod, "id");
    expect(result.modifiedCount).toBe(1);
    expect(result.rows[0].status).toBe("modified");
    expect(result.rows[0].changedColumns).toContain("name");
  });

  it("detects unchanged rows", () => {
    const result = diffSql(row1, row1, "id");
    expect(result.unchangedCount).toBe(1);
    expect(result.rows[0].status).toBe("unchanged");
  });

  it("handles multiple rows across statuses", () => {
    const left = `${row1}\n${row2}`;
    const right = `${row1mod}\n${row2}`;
    const result = diffSql(left, right, "id");
    expect(result.modifiedCount).toBe(1);
    expect(result.unchangedCount).toBe(1);
  });

  it("supports per-table dedup (same key in different tables)", () => {
    const left = "INSERT INTO `a` (`id`) VALUES (1);\n" +
                 "INSERT INTO `b` (`id`) VALUES (1);";
    const right = "INSERT INTO `a` (`id`) VALUES (1);";
    const result = diffSql(left, right, "id");
    // `b`.id=1 removed, `a`.id=1 unchanged
    expect(result.removedCount).toBe(1);
    expect(result.unchangedCount).toBe(1);
  });

  it("supports keyColIndex for INSERTs without column list", () => {
    const left = "INSERT INTO `t` VALUES (1, 'old');";
    const right = "INSERT INTO `t` VALUES (1, 'new');";
    const result = diffSql(left, right, undefined, 1);
    expect(result.modifiedCount).toBe(1);
  });

  it("returns empty result for empty inputs", () => {
    const result = diffSql("", "", "id");
    expect(result.rows).toHaveLength(0);
    expect(result.addedCount).toBe(0);
  });
});

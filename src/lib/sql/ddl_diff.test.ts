// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseDDL, diffDDL, generateAlterSql } from "./ddl_diff";

// ─── parseDDL ─────────────────────────────────────────────────────────────────

describe("parseDDL", () => {
  const SIMPLE_DDL = `
    CREATE TABLE \`users\` (
      \`id\`    INT NOT NULL AUTO_INCREMENT,
      \`name\`  VARCHAR(100) NOT NULL DEFAULT '',
      \`email\` VARCHAR(255) NULL,
      PRIMARY KEY (\`id\`),
      UNIQUE KEY \`uk_email\` (\`email\`),
      KEY \`idx_name\` (\`name\`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  it("parses table name", () => {
    const def = parseDDL(SIMPLE_DDL);
    expect(def.tableName).toBe("users");
  });

  it("parses 3 columns", () => {
    const def = parseDDL(SIMPLE_DDL);
    expect(def.columns).toHaveLength(3);
    expect(def.columns[0].name).toBe("id");
    expect(def.columns[1].name).toBe("name");
    expect(def.columns[2].name).toBe("email");
  });

  it("parses fullDef correctly", () => {
    const def = parseDDL(SIMPLE_DDL);
    expect(def.columns[0].fullDef.toUpperCase()).toContain("INT");
    expect(def.columns[0].fullDef.toUpperCase()).toContain("NOT NULL");
  });

  it("parses PRIMARY KEY", () => {
    const def = parseDDL(SIMPLE_DDL);
    const pk = def.indexes.find((i) => i.type === "PRIMARY");
    expect(pk).toBeDefined();
    expect(pk!.columns).toEqual(["id"]);
  });

  it("parses UNIQUE KEY", () => {
    const def = parseDDL(SIMPLE_DDL);
    const uk = def.indexes.find((i) => i.type === "UNIQUE");
    expect(uk).toBeDefined();
    expect(uk!.name).toBe("uk_email");
    expect(uk!.columns).toEqual(["email"]);
  });

  it("parses regular KEY", () => {
    const def = parseDDL(SIMPLE_DDL);
    const idx = def.indexes.find((i) => i.type === "INDEX");
    expect(idx).toBeDefined();
    expect(idx!.name).toBe("idx_name");
  });

  it("throws on zero CREATE TABLE", () => {
    expect(() => parseDDL("SELECT 1;")).toThrow("未找到 CREATE TABLE");
  });

  it("throws on multiple CREATE TABLE", () => {
    const multi = `
      CREATE TABLE a (id INT);
      CREATE TABLE b (id INT);
    `;
    expect(() => parseDDL(multi)).toThrow("多个 CREATE TABLE");
  });

  it("handles double-quoted identifiers (PostgreSQL style)", () => {
    const pg = `CREATE TABLE "orders" ("order_id" SERIAL PRIMARY KEY, "amount" NUMERIC(10,2));`;
    const def = parseDDL(pg);
    expect(def.tableName).toBe("orders");
    expect(def.columns[0].name).toBe("order_id");
  });

  it("strips line comments", () => {
    const ddl = `
      CREATE TABLE foo (
        id INT, -- primary key
        name VARCHAR(50) -- user name
      );
    `;
    const def = parseDDL(ddl);
    expect(def.columns).toHaveLength(2);
  });
});

// ─── diffDDL ──────────────────────────────────────────────────────────────────

describe("diffDDL", () => {
  const FROM_DDL = `
    CREATE TABLE \`users\` (
      \`id\`    INT NOT NULL AUTO_INCREMENT,
      \`name\`  VARCHAR(100) NOT NULL,
      \`age\`   INT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_name\` (\`name\`)
    );
  `;

  const TO_DDL_ADD_COL = `
    CREATE TABLE \`users\` (
      \`id\`    INT NOT NULL AUTO_INCREMENT,
      \`name\`  VARCHAR(100) NOT NULL,
      \`age\`   INT NULL,
      \`email\` VARCHAR(255) NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_name\` (\`name\`)
    );
  `;

  const TO_DDL_REMOVE_COL = `
    CREATE TABLE \`users\` (
      \`id\`    INT NOT NULL AUTO_INCREMENT,
      \`name\`  VARCHAR(100) NOT NULL,
      PRIMARY KEY (\`id\`)
    );
  `;

  const TO_DDL_MODIFY_COL = `
    CREATE TABLE \`users\` (
      \`id\`    INT NOT NULL AUTO_INCREMENT,
      \`name\`  VARCHAR(200) NOT NULL,
      \`age\`   TINYINT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_name\` (\`name\`)
    );
  `;

  const TO_DDL_ADD_INDEX = `
    CREATE TABLE \`users\` (
      \`id\`    INT NOT NULL AUTO_INCREMENT,
      \`name\`  VARCHAR(100) NOT NULL,
      \`age\`   INT NULL,
      PRIMARY KEY (\`id\`),
      KEY \`idx_name\` (\`name\`),
      KEY \`idx_age\` (\`age\`)
    );
  `;

  it("detects no changes when DDLs are identical", () => {
    const from = parseDDL(FROM_DDL);
    const diff = diffDDL(from, from);
    expect(diff.hasChanges).toBe(false);
  });

  it("detects added column", () => {
    const from = parseDDL(FROM_DDL);
    const to   = parseDDL(TO_DDL_ADD_COL);
    const diff = diffDDL(from, to);
    const added = diff.columnChanges.filter((c) => c.kind === "added");
    expect(added).toHaveLength(1);
    expect(added[0].column.name).toBe("email");
  });

  it("detects removed column", () => {
    const from = parseDDL(FROM_DDL);
    const to   = parseDDL(TO_DDL_REMOVE_COL);
    const diff = diffDDL(from, to);
    const removed = diff.columnChanges.filter((c) => c.kind === "removed");
    expect(removed).toHaveLength(1);
    expect(removed[0].column.name).toBe("age");
  });

  it("detects modified column", () => {
    const from = parseDDL(FROM_DDL);
    const to   = parseDDL(TO_DDL_MODIFY_COL);
    const diff = diffDDL(from, to);
    const modified = diff.columnChanges.filter((c) => c.kind === "modified");
    expect(modified).toHaveLength(2);
    const names = modified.map((c) => c.column.name).sort();
    expect(names).toEqual(["age", "name"]);
  });

  it("detects added index", () => {
    const from = parseDDL(FROM_DDL);
    const to   = parseDDL(TO_DDL_ADD_INDEX);
    const diff = diffDDL(from, to);
    const added = diff.indexChanges.filter((c) => c.kind === "added");
    expect(added).toHaveLength(1);
    expect(added[0].index.name).toBe("idx_age");
  });

  it("skips index diff when includeIndexes=false", () => {
    const from = parseDDL(FROM_DDL);
    const to   = parseDDL(TO_DDL_ADD_INDEX);
    const diff = diffDDL(from, to, false);
    expect(diff.indexChanges).toHaveLength(0);
  });
});

// ─── generateAlterSql ─────────────────────────────────────────────────────────

describe("generateAlterSql — MySQL", () => {
  it("generates ADD COLUMN", () => {
    const from = parseDDL("CREATE TABLE `t` (`id` INT NOT NULL);");
    const to   = parseDDL("CREATE TABLE `t` (`id` INT NOT NULL, `name` VARCHAR(100));");
    const diff = diffDDL(from, to);
    const sql = generateAlterSql(diff, "mysql");
    expect(sql).toContain("ALTER TABLE `t` ADD COLUMN `name` VARCHAR(100);");
  });

  it("generates DROP COLUMN", () => {
    const from = parseDDL("CREATE TABLE `t` (`id` INT NOT NULL, `name` VARCHAR(100));");
    const to   = parseDDL("CREATE TABLE `t` (`id` INT NOT NULL);");
    const diff = diffDDL(from, to);
    const sql = generateAlterSql(diff, "mysql");
    expect(sql).toContain("ALTER TABLE `t` DROP COLUMN `name`;");
  });

  it("generates MODIFY COLUMN", () => {
    const from = parseDDL("CREATE TABLE `t` (`id` INT NOT NULL);");
    const to   = parseDDL("CREATE TABLE `t` (`id` BIGINT NOT NULL);");
    const diff = diffDDL(from, to);
    const sql = generateAlterSql(diff, "mysql");
    expect(sql).toContain("ALTER TABLE `t` MODIFY COLUMN `id` BIGINT NOT NULL;");
  });

  it("generates ADD INDEX", () => {
    const from = parseDDL("CREATE TABLE `t` (`id` INT, `name` VARCHAR(50), PRIMARY KEY (`id`));");
    const to   = parseDDL("CREATE TABLE `t` (`id` INT, `name` VARCHAR(50), PRIMARY KEY (`id`), KEY `idx_name` (`name`));");
    const diff = diffDDL(from, to);
    const sql = generateAlterSql(diff, "mysql");
    expect(sql).toContain("ADD INDEX `idx_name`");
  });

  it("generates DROP INDEX", () => {
    const from = parseDDL("CREATE TABLE `t` (`id` INT, `name` VARCHAR(50), PRIMARY KEY (`id`), KEY `idx_name` (`name`));");
    const to   = parseDDL("CREATE TABLE `t` (`id` INT, `name` VARCHAR(50), PRIMARY KEY (`id`));");
    const diff = diffDDL(from, to);
    const sql = generateAlterSql(diff, "mysql");
    expect(sql).toContain("DROP INDEX `idx_name`;");
  });
});

describe("generateAlterSql — PostgreSQL", () => {
  it("generates ADD COLUMN", () => {
    const from = parseDDL(`CREATE TABLE "t" ("id" SERIAL NOT NULL)`);
    const to   = parseDDL(`CREATE TABLE "t" ("id" SERIAL NOT NULL, "email" VARCHAR(255))`);
    const diff = diffDDL(from, to);
    const sql = generateAlterSql(diff, "postgresql");
    expect(sql).toContain(`ALTER TABLE "t" ADD COLUMN "email" VARCHAR(255);`);
  });

  it("generates ALTER COLUMN TYPE for modified column", () => {
    const from = parseDDL(`CREATE TABLE "t" ("id" INT NOT NULL)`);
    const to   = parseDDL(`CREATE TABLE "t" ("id" BIGINT NOT NULL)`);
    const diff = diffDDL(from, to);
    const sql = generateAlterSql(diff, "postgresql");
    expect(sql).toContain(`ALTER COLUMN "id" TYPE BIGINT`);
  });

  it("generates CREATE INDEX", () => {
    const from = parseDDL(`CREATE TABLE "t" ("id" INT, "name" VARCHAR(50), PRIMARY KEY ("id"))`);
    const to   = parseDDL(`CREATE TABLE "t" ("id" INT, "name" VARCHAR(50), PRIMARY KEY ("id"), UNIQUE KEY "uk_name" ("name"))`);
    const diff = diffDDL(from, to);
    const sql = generateAlterSql(diff, "postgresql");
    expect(sql).toContain(`CREATE UNIQUE INDEX "uk_name" ON "t"`);
  });
});

describe("generateAlterSql — Oracle", () => {
  it("generates MODIFY column", () => {
    const from = parseDDL(`CREATE TABLE "t" ("id" NUMBER NOT NULL)`);
    const to   = parseDDL(`CREATE TABLE "t" ("id" NUMBER(20) NOT NULL)`);
    const diff = diffDDL(from, to);
    const sql = generateAlterSql(diff, "oracle");
    expect(sql).toContain(`ALTER TABLE "t" MODIFY "id" NUMBER(20) NOT NULL;`);
  });
});

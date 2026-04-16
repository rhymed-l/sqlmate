export interface DialectRule {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
  apply: (sql: string) => string;
}

// Build a list of MySQL→PostgreSQL conversion rules (togglable).
export function buildDialectRules(): DialectRule[] {
  return [
    {
      id: "backticks",
      label: "反引号 → 双引号",
      description: "`identifier` → \"identifier\"",
      enabled: true,
      apply: (sql) => sql.replace(/`([^`]+)`/g, '"$1"'),
    },
    {
      id: "auto_increment",
      label: "AUTO_INCREMENT → SERIAL",
      description: "INT AUTO_INCREMENT → SERIAL",
      enabled: true,
      apply: (sql) =>
        sql.replace(/\b(INT|INTEGER|BIGINT)\s+AUTO_INCREMENT\b/gi, "SERIAL"),
    },
    {
      id: "tinyint_bool",
      label: "TINYINT(1) → BOOLEAN",
      description: "MySQL 布尔字段",
      enabled: true,
      apply: (sql) => sql.replace(/\bTINYINT\s*\(\s*1\s*\)/gi, "BOOLEAN"),
    },
    {
      id: "datetime",
      label: "DATETIME → TIMESTAMP",
      description: "日期时间类型转换",
      enabled: true,
      apply: (sql) => sql.replace(/\bDATETIME\b/gi, "TIMESTAMP"),
    },
    {
      id: "engine",
      label: "删除 ENGINE= 子句",
      description: "ENGINE=InnoDB, ENGINE=MyISAM 等",
      enabled: true,
      apply: (sql) =>
        sql.replace(/\s*ENGINE\s*=\s*\w+\s*/gi, " "),
    },
    {
      id: "charset",
      label: "删除 CHARSET= / CHARACTER SET 子句",
      description: "DEFAULT CHARSET=utf8mb4 等",
      enabled: true,
      apply: (sql) =>
        sql
          .replace(/\s*DEFAULT\s+CHARSET\s*=\s*\w+/gi, "")
          .replace(/\s*CHARACTER\s+SET\s+\w+/gi, ""),
    },
    {
      id: "collate",
      label: "删除 COLLATE= 子句",
      description: "COLLATE=utf8mb4_unicode_ci 等",
      enabled: true,
      apply: (sql) => sql.replace(/\s*COLLATE\s*=?\s*[\w_]+/gi, ""),
    },
    {
      id: "unsigned",
      label: "删除 UNSIGNED",
      description: "PostgreSQL 无 UNSIGNED 修饰符",
      enabled: true,
      apply: (sql) => sql.replace(/\bUNSIGNED\b/gi, ""),
    },
    {
      id: "zero_fill",
      label: "删除 ZEROFILL",
      description: "PostgreSQL 不支持",
      enabled: true,
      apply: (sql) => sql.replace(/\bZEROFILL\b/gi, ""),
    },
  ];
}

export interface ConvertDialectResult {
  sql: string;
  appliedRules: string[];
}

export function convertDialect(
  sql: string,
  rules: DialectRule[]
): ConvertDialectResult {
  let result = sql;
  const appliedRules: string[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const after = rule.apply(result);
    if (after !== result) {
      appliedRules.push(rule.label);
      result = after;
    }
  }

  return { sql: result, appliedRules };
}

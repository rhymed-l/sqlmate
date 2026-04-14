import { format } from "sql-formatter";

export type SqlDialect =
  | "mysql"
  | "postgresql"
  | "tsql"
  | "plsql"
  | "sqlite"
  | "bigquery";

export interface FormatOptions {
  dialect: SqlDialect;
  indent: 2 | 4;
}

export interface FormatResult {
  sql: string;
  success: boolean;
  warning?: string;
}

export const DIALECT_OPTIONS: { value: SqlDialect; label: string }[] = [
  { value: "mysql", label: "MySQL" },
  { value: "postgresql", label: "PostgreSQL" },
  { value: "tsql", label: "SQL Server" },
  { value: "plsql", label: "Oracle" },
  { value: "sqlite", label: "SQLite" },
  { value: "bigquery", label: "BigQuery" },
];

export function formatSQL(sql: string, options: FormatOptions): FormatResult {
  try {
    const formatted = format(sql, {
      language: options.dialect,
      tabWidth: options.indent,
      keywordCase: "upper",
    });
    return { sql: formatted, success: true };
  } catch {
    return {
      sql,
      success: false,
      warning: "部分语句无法格式化，已返回原始 SQL",
    };
  }
}

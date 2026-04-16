export type RuleType = "table" | "column" | "prefix";

export interface RenameRule {
  type: RuleType;
  from: string;
  to: string;
}

export interface RenameResult {
  sql: string;
  replacedCount: number; // number of INSERT lines modified
}

// Apply one INSERT line transformation for all rules.
// Returns the (possibly modified) line.
function applyRulesToLine(line: string, rules: RenameRule[]): string {
  // Only process INSERT INTO lines
  if (!/^INSERT\s+INTO\s+/i.test(line)) return line;

  // Extract parts: INSERT INTO `tableName` (optional col list) VALUES (...)
  // We do targeted replacements rather than full re-serialization to avoid
  // touching the VALUES section.

  let result = line;

  for (const rule of rules) {
    if (rule.from === rule.to) continue;

    if (rule.type === "table") {
      // Replace table name exactly (backtick-quoted or unquoted)
      result = replaceTableName(result, rule.from, rule.to, false);
    } else if (rule.type === "prefix") {
      // Replace table name that starts with `from` prefix
      result = replacePrefixTableName(result, rule.from, rule.to);
    } else if (rule.type === "column") {
      // Replace column name in the column list section
      result = replaceColumnName(result, rule.from, rule.to);
    }
  }

  return result;
}

// Replace exact table name after INSERT INTO
function replaceTableName(line: string, from: string, to: string, _prefix: boolean): string {
  // Match: INSERT INTO `from` or INSERT INTO from
  // Use regex to match the table name position
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(INSERT\\s+INTO\\s+)(\`${escaped}\`|(?<!\`)\\b${escaped}\\b(?!\`))`,
    "i"
  );
  return line.replace(re, `$1\`${to}\``);
}

// Replace table name that starts with a prefix
function replacePrefixTableName(line: string, fromPrefix: string, toPrefix: string): string {
  const escaped = fromPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match: INSERT INTO `prefixXxx` or INSERT INTO prefixXxx
  const re = new RegExp(
    `(INSERT\\s+INTO\\s+)(\`${escaped}([^)\`\\s]*)\`|(?<!\`)\\b${escaped}(\\S*?)\\b(?![\`(]))`,
    "i"
  );
  return line.replace(re, (_m, prefix, _full, rest1, rest2) => {
    const rest = rest1 ?? rest2 ?? "";
    return `${prefix}\`${toPrefix}${rest}\``;
  });
}

// Replace a column name in the column list (between INSERT INTO `t` ( ... ) VALUES)
function replaceColumnName(line: string, from: string, to: string): string {
  // Find the column list section: between first '(' (after table name) and 'VALUES'
  const valuesMatch = line.match(/VALUES\s*\(/i);
  if (!valuesMatch || valuesMatch.index === undefined) return line;

  // Find the opening paren before VALUES
  const beforeValues = line.slice(0, valuesMatch.index);
  const firstParen = beforeValues.indexOf("(");
  if (firstParen === -1) return line;

  const colSection = beforeValues.slice(firstParen + 1, beforeValues.lastIndexOf(")"));
  const afterColSection = line.slice(firstParen + 1 + colSection.length);

  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match backtick-quoted or bare column name
  const re = new RegExp(`(\`${escaped}\`|(?<!\`)\\b${escaped}\\b(?!\`))`, "gi");
  const newColSection = colSection.replace(re, `\`${to}\``);

  return beforeValues.slice(0, firstParen + 1) + newColSection + afterColSection;
}

export function renameSql(sql: string, rules: RenameRule[]): RenameResult {
  if (rules.length === 0) return { sql, replacedCount: 0 };

  const lines = sql.split("\n");
  let replacedCount = 0;
  const outputLines = lines.map((line) => {
    const trimmed = line.trimEnd();
    if (!/^INSERT\s+INTO\s+/i.test(trimmed)) return trimmed;
    const modified = applyRulesToLine(trimmed, rules);
    if (modified !== trimmed) replacedCount++;
    return modified;
  });

  // Trim trailing blank lines
  while (outputLines.length > 0 && outputLines[outputLines.length - 1].trim() === "") {
    outputLines.pop();
  }

  return { sql: outputLines.join("\n"), replacedCount };
}

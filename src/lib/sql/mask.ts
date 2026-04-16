import { parseInsertLine } from "./dedupe";

export type MaskType =
  | "phone"
  | "id_card"
  | "email"
  | "name"
  | "custom_mask"
  | "regex_replace";

export interface MaskRule {
  column: string;
  type: MaskType;
  customValue?: string;    // for custom_mask
  regexPattern?: string;   // for regex_replace
  regexReplace?: string;   // for regex_replace replacement template
}

export interface MaskResult {
  sql: string;
  maskedCount: number; // number of INSERT lines where at least one column was masked
  warnings: string[];
}

// Deterministic pseudo-random from a seed string (for consistency: same input → same fake value)
function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

const CHINESE_SURNAMES = ["王", "李", "张", "刘", "陈", "杨", "黄", "赵", "吴", "周",
  "徐", "孙", "马", "朱", "胡", "郭", "何", "高", "林", "郑"];
const CHINESE_NAMES = ["伟", "芳", "娜", "秀英", "敏", "静", "丽", "强", "磊", "洋",
  "艳", "勇", "军", "杰", "娟", "涛", "明", "超", "秀兰", "霞"];

function fakePhone(seed: string): string {
  const h = hashCode(seed);
  const prefixes = ["130", "131", "132", "133", "134", "135", "136", "137",
                    "138", "139", "150", "151", "152", "153", "155", "156",
                    "157", "158", "159", "170", "171", "172", "173", "175",
                    "176", "177", "178", "180", "181", "182", "183", "184",
                    "185", "186", "187", "188", "189"];
  const prefix = prefixes[h % prefixes.length];
  const rest = String(((h * 1234567) % 100000000)).padStart(8, "0");
  return prefix + rest;
}

function fakeIdCard(seed: string): string {
  const h = hashCode(seed);
  // 6-digit area code (simplified) + 8-digit birth date + 3-digit seq + 1 check
  const area = String(100000 + (h % 900000));
  const year = 1970 + (h % 40);
  const month = String(1 + (h % 12)).padStart(2, "0");
  const day = String(1 + (h % 28)).padStart(2, "0");
  const seq = String((h % 999) + 1).padStart(3, "0");
  return `${area}${year}${month}${day}${seq}X`;
}

function fakeEmail(seed: string): string {
  const h = hashCode(seed);
  return `user_${h % 100000}@example.com`;
}

function fakeName(seed: string): string {
  const h = hashCode(seed);
  const surname = CHINESE_SURNAMES[h % CHINESE_SURNAMES.length];
  const given = CHINESE_NAMES[(h >> 4) % CHINESE_NAMES.length];
  return surname + given;
}

// Cache: original value → fake value (for consistency within a session)
type MaskCache = Map<string, string>;

function applyMaskType(
  rawValue: string,
  rule: MaskRule,
  cache: MaskCache
): string {
  // rawValue may be a SQL-quoted string like 'Alice' or a number
  const isQuoted = rawValue.startsWith("'") && rawValue.endsWith("'");
  const inner = isQuoted ? rawValue.slice(1, -1).replace(/''/g, "'") : rawValue;

  // Use cache key = "col:inner"
  const cacheKey = `${rule.column}:${rule.type}:${inner}`;
  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey)!;
    return isQuoted ? `'${cached.replace(/'/g, "''")}'` : cached;
  }

  let fakeInner: string;
  switch (rule.type) {
    case "phone":
      fakeInner = fakePhone(cacheKey);
      break;
    case "id_card":
      fakeInner = fakeIdCard(cacheKey);
      break;
    case "email":
      fakeInner = fakeEmail(cacheKey);
      break;
    case "name":
      fakeInner = fakeName(cacheKey);
      break;
    case "custom_mask":
      fakeInner = rule.customValue ?? "***";
      break;
    case "regex_replace": {
      if (!rule.regexPattern) { fakeInner = inner; break; }
      try {
        const re = new RegExp(rule.regexPattern, "g");
        fakeInner = inner.replace(re, rule.regexReplace ?? "***");
      } catch {
        fakeInner = inner;
      }
      break;
    }
    default:
      fakeInner = inner;
  }

  cache.set(cacheKey, fakeInner);
  return isQuoted ? `'${fakeInner.replace(/'/g, "''")}'` : fakeInner;
}

export function maskSql(sql: string, rules: MaskRule[]): MaskResult {
  if (rules.length === 0) {
    return { sql, maskedCount: 0, warnings: [] };
  }

  const cache: MaskCache = new Map();
  const lines = sql.split("\n");
  let maskedCount = 0;
  const warningSet = new Set<string>();

  const outputLines = lines.map((line) => {
    const trimmed = line.trimEnd();
    if (!/^INSERT\s+INTO\s+/i.test(trimmed)) return trimmed;

    const parsed = parseInsertLine(trimmed);
    if (!parsed) return trimmed;

    const { tableName, columns, values } = parsed;
    if (!columns) return trimmed; // can't mask without column names

    const newValues = [...values];
    let lineModified = false;

    for (const rule of rules) {
      const idx = columns.findIndex(
        (c) => c.toLowerCase() === rule.column.toLowerCase()
      );
      if (idx === -1) {
        warningSet.add(`列 "${rule.column}" 不存在，已跳过`);
        continue;
      }
      const original = newValues[idx];
      const masked = applyMaskType(original, rule, cache);
      if (masked !== original) {
        newValues[idx] = masked;
        lineModified = true;
      }
    }

    if (!lineModified) return trimmed;
    maskedCount++;

    const colPart = `(${columns.map((c) => `\`${c}\``).join(", ")})`;
    return `INSERT INTO \`${tableName}\` ${colPart} VALUES (${newValues.join(", ")});`;
  });

  while (outputLines.length > 0 && outputLines[outputLines.length - 1].trim() === "") {
    outputLines.pop();
  }

  return {
    sql: outputLines.join("\n"),
    maskedCount,
    warnings: Array.from(warningSet),
  };
}

/**
 * SQL processing Web Worker.
 * All CPU-heavy small-file operations run here so the main thread stays responsive.
 */
import { dedupeSql } from "@/lib/sql/dedupe";
import { renameSql } from "@/lib/sql/rename";
import { offsetSql } from "@/lib/sql/offset";
import { maskSql } from "@/lib/sql/mask";
import { diffSql } from "@/lib/sql/diff";
import { convertStatements } from "@/lib/sql/convert_stmt";
import { convertDialect } from "@/lib/sql/dialect";
import { mergeSQL } from "@/lib/sql/merge";
import { splitSQL } from "@/lib/sql/split";
import { formatSQL } from "@/lib/sql/format";

type WorkerRequest = { id: number; type: string } & Record<string, unknown>;

self.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const { id, type, ...payload } = e.data;
  try {
    let result: unknown;
    switch (type) {
      case "dedupe":
        result = dedupeSql(payload.sql as string, payload.options as Parameters<typeof dedupeSql>[1]);
        break;
      case "rename":
        result = renameSql(payload.sql as string, payload.rules as Parameters<typeof renameSql>[1]);
        break;
      case "offset":
        result = offsetSql(payload.sql as string, payload.rules as Parameters<typeof offsetSql>[1]);
        break;
      case "mask":
        result = maskSql(payload.sql as string, payload.rules as Parameters<typeof maskSql>[1]);
        break;
      case "diff":
        result = diffSql(
          payload.leftSql as string,
          payload.rightSql as string,
          payload.keyColumn as string | undefined,
          payload.keyColIndex as number | undefined,
        );
        break;
      case "convertStmt":
        result = convertStatements(payload.sql as string, payload.options as Parameters<typeof convertStatements>[1]);
        break;
      case "dialect":
        result = convertDialect(payload.sql as string, payload.rules as Parameters<typeof convertDialect>[1]);
        break;
      case "merge":
        result = mergeSQL(payload.sql as string, payload.options as Parameters<typeof mergeSQL>[1]);
        break;
      case "split":
        result = splitSQL(payload.sql as string);
        break;
      case "format":
        result = formatSQL(payload.sql as string, payload.options as Parameters<typeof formatSQL>[1]);
        break;
      default:
        throw new Error(`Unknown worker task: ${type}`);
    }
    self.postMessage({ id, result });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};

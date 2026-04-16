use calamine::{open_workbook, Data, Reader, Xlsx};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;
use tauri::Emitter;

#[derive(serde::Serialize, Clone)]
struct ProgressEvent {
    percent: u8,
}

/// Emit a progress event at most once per percentage point to avoid IPC flood.
fn emit_progress(
    app: &tauri::AppHandle,
    bytes_read: u64,
    total_bytes: u64,
    last_percent: &mut u8,
) {
    if total_bytes == 0 {
        return;
    }
    let current = ((bytes_read as f64 / total_bytes as f64) * 100.0).min(100.0) as u8;
    if current > *last_percent {
        *last_percent = current;
        app.emit("stream-progress", ProgressEvent { percent: current }).ok();
    }
}

// ─── basic commands ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn write_files_to_folder(
    folder: String,
    files: Vec<(String, String)>,
) -> Result<(), String> {
    for (name, content) in &files {
        let dest = Path::new(&folder).join(name);
        fs::write(&dest, content)
            .map_err(|e| format!("写入 {} 失败: {}", name, e))?;
    }
    Ok(())
}

/// Return the byte size of a file without reading its content.
#[tauri::command]
pub async fn file_size(path: String) -> Result<u64, String> {
    fs::metadata(&path)
        .map(|m| m.len())
        .map_err(|e| e.to_string())
}

// ─── streaming segment ─────────────────────────────────────────────────────

/// Stream-split a large SQL file into multiple smaller files.
/// Memory usage is O(one SQL statement), not O(file size).
#[tauri::command]
pub async fn segment_file(
    app: tauri::AppHandle,
    input_path: String,
    output_folder: String,
    mode: String,
    value: u64,
) -> Result<u32, String> {
    let total_bytes = fs::metadata(&input_path).map(|m| m.len()).unwrap_or(0);
    let file =
        File::open(&input_path).map_err(|e| format!("无法打开文件: {}", e))?;
    let reader = BufReader::new(file);

    let mut file_index: u32 = 0;
    let mut chunk_count: u64 = 0;
    let mut chunk_bytes: u64 = 0;
    let mut stmt_buf = String::new();
    let mut current_writer: Option<BufWriter<File>> = None;
    let mut bytes_read: u64 = 0;
    let mut last_percent: u8 = 0;

    let make_writer = |idx: u32| -> Result<BufWriter<File>, String> {
        let name = format!("output_{:03}.sql", idx);
        let path = Path::new(&output_folder).join(&name);
        let f = File::create(&path)
            .map_err(|e| format!("创建输出文件失败: {}", e))?;
        Ok(BufWriter::new(f))
    };

    for line_result in reader.lines() {
        let line = line_result.map_err(|e| format!("读取失败: {}", e))?;
        bytes_read += line.len() as u64 + 1;
        emit_progress(&app, bytes_read, total_bytes, &mut last_percent);

        stmt_buf.push_str(&line);
        stmt_buf.push('\n');

        if line.trim_end().ends_with(';') {
            let stmt = stmt_buf.trim();
            if stmt.is_empty() {
                stmt_buf.clear();
                continue;
            }
            let stmt_bytes = stmt.len() as u64;

            let should_rotate = match mode.as_str() {
                "count" => chunk_count >= value && current_writer.is_some(),
                "size" => {
                    chunk_bytes + stmt_bytes > value * 1024 * 1024
                        && current_writer.is_some()
                        && chunk_count > 0
                }
                _ => false,
            };

            if should_rotate {
                if let Some(ref mut w) = current_writer {
                    w.flush().map_err(|e| e.to_string())?;
                }
                current_writer = None;
                chunk_count = 0;
                chunk_bytes = 0;
            }

            if current_writer.is_none() {
                file_index += 1;
                current_writer = Some(make_writer(file_index)?);
            }

            if let Some(ref mut w) = current_writer {
                w.write_all(stmt.as_bytes()).map_err(|e| e.to_string())?;
                w.write_all(b"\n").map_err(|e| e.to_string())?;
            }

            chunk_count += 1;
            chunk_bytes += stmt_bytes;
            stmt_buf.clear();
        }
    }

    // Remaining partial content (no trailing semicolon)
    let remaining = stmt_buf.trim();
    if !remaining.is_empty() {
        if current_writer.is_none() {
            file_index += 1;
            current_writer = Some(make_writer(file_index)?);
        }
        if let Some(ref mut w) = current_writer {
            w.write_all(remaining.as_bytes()).map_err(|e| e.to_string())?;
            w.write_all(b"\n").map_err(|e| e.to_string())?;
        }
    }

    if let Some(mut w) = current_writer {
        w.flush().map_err(|e| e.to_string())?;
    }

    Ok(file_index)
}

// ─── SQL parsing helpers ────────────────────────────────────────────────────

/// Parsed INSERT header.
struct InsertHeader {
    /// Original INSERT prefix as written, e.g. `INSERT INTO` or `INSERT IGNORE INTO`
    insert_prefix: String,
    /// Original table expression as written (e.g. `` `db`.`tbl` `` or `tbl`)
    table_expr: String,
    /// Original column list with parens, e.g. `(col1, col2)`, or empty string
    columns: String,
    /// Byte offset in the statement where the VALUES data begins
    values_offset: usize,
}

/// Parse an INSERT statement header to extract table expr, column list, and
/// the byte offset of the VALUES data.
///
/// Handles:
///   INSERT [LOW_PRIORITY|DELAYED|HIGH_PRIORITY] [IGNORE] INTO
///   [`db`.]`table` [(col_list)] VALUES
fn parse_insert_header(stmt: &str) -> Option<InsertHeader> {
    use regex::Regex;
    use std::sync::OnceLock;

    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(
            r"(?i)(INSERT\s+(?:LOW_PRIORITY\s+|DELAYED\s+|HIGH_PRIORITY\s+|IGNORE\s+)?INTO)\s+((?:`[^`]+`|\w+)(?:\.(?:`[^`]+`|\w+))?)\s*(\([^)]*\))?\s*VALUES\s*",
        )
        .expect("invalid INSERT regex")
    });

    let cap = re.captures(stmt)?;
    let insert_prefix = cap[1].to_string();
    let table_expr = cap[2].to_string();
    let columns = cap.get(3).map(|m| m.as_str().to_string()).unwrap_or_default();
    // values_offset points to the first byte AFTER "VALUES\s*"
    let values_offset = cap.get(0)?.end();

    Some(InsertHeader { insert_prefix, table_expr, columns, values_offset })
}

/// Split a VALUES string "(a,b),(c,d),..." into individual tuple strings.
///
/// Uses **byte-level** scanning — O(n) time, O(output) memory.
/// Safe for UTF-8 because all delimiter chars are single-byte ASCII and UTF-8
/// multi-byte sequences never contain ASCII bytes.
fn split_value_tuples(values: &[u8]) -> Vec<&[u8]> {
    let mut tuples = Vec::new();
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut i = 0;
    let mut tuple_start = 0;

    while i < values.len() {
        let b = values[i];

        if in_string {
            match b {
                b'\\' => {
                    // skip next byte (backslash escape: \' etc.)
                    i += 2;
                    continue;
                }
                b'\'' => {
                    // handle '' (SQL standard double-quote escape)
                    if i + 1 < values.len() && values[i + 1] == b'\'' {
                        i += 2;
                        continue;
                    }
                    in_string = false;
                }
                _ => {}
            }
        } else {
            match b {
                b'\'' => in_string = true,
                b'(' => {
                    if depth == 0 {
                        tuple_start = i; // record start of this tuple
                    }
                    depth += 1;
                }
                b')' => {
                    depth -= 1;
                    if depth == 0 {
                        // inclusive slice [tuple_start..=i]
                        let tuple = &values[tuple_start..=i];
                        if !tuple.is_empty() {
                            tuples.push(tuple);
                        }
                        // skip past comma + whitespace to next tuple
                        i += 1;
                        while i < values.len()
                            && matches!(values[i], b',' | b' ' | b'\t' | b'\r' | b'\n')
                        {
                            i += 1;
                        }
                        continue;
                    }
                }
                _ => {}
            }
        }
        i += 1;
    }

    tuples
}

// ─── streaming merge ────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct MergeStats {
    pub table_count: usize,
    pub statement_count: usize,
}

/// Merge single-row INSERT statements into batched INSERTs.
/// Flushes complete batches to disk immediately — memory is bounded by
/// (num_tables × batch_size) tuples at any point in time.
#[tauri::command]
pub async fn merge_file(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    batch_size: usize,
) -> Result<MergeStats, String> {
    let total_bytes = fs::metadata(&input_path).map(|m| m.len()).unwrap_or(0);
    let file =
        File::open(&input_path).map_err(|e| format!("无法打开文件: {}", e))?;
    let reader = BufReader::new(file);

    let out =
        File::create(&output_path).map_err(|e| format!("创建输出文件失败: {}", e))?;
    let mut writer = BufWriter::new(out);

    // key → (table_expr, columns, buffered_tuples)
    let mut order: Vec<String> = Vec::new();
    let mut groups: HashMap<String, (String, String, String, Vec<Vec<u8>>)> = HashMap::new();
    let mut statement_count = 0;
    let mut stmt_buf = String::new();
    let mut bytes_read: u64 = 0;
    let mut last_percent: u8 = 0;

    // Write one complete INSERT batch and return statement count increment.
    let flush_batch = |writer: &mut BufWriter<File>,
                       insert_prefix: &str,
                       table_expr: &str,
                       columns: &str,
                       chunk: &[Vec<u8>]|
     -> Result<(), String> {
        let sep = if columns.is_empty() { "" } else { " " };
        write!(writer, "{} {}{}{} VALUES\n", insert_prefix, table_expr, sep, columns)
            .map_err(|e| e.to_string())?;
        let mut first = true;
        for t in chunk {
            if !first {
                writer.write_all(b",\n").map_err(|e| e.to_string())?;
            }
            writer.write_all(t).map_err(|e| e.to_string())?;
            first = false;
        }
        writer.write_all(b";\n\n").map_err(|e| e.to_string())?;
        Ok(())
    };

    // key → (insert_prefix, table_expr, columns, buffered_tuples)
    let process = |stmt: &str,
                       writer: &mut BufWriter<File>,
                       order: &mut Vec<String>,
                       groups: &mut HashMap<String, (String, String, String, Vec<Vec<u8>>)>,
                       statement_count: &mut usize|
     -> Result<(), String> {
        let h = match parse_insert_header(stmt) {
            Some(h) => h,
            None => return Ok(()),
        };
        let vals_bytes = stmt.as_bytes();
        let vals_slice = match vals_bytes.get(h.values_offset..) {
            Some(s) => s,
            None => return Ok(()),
        };
        let vals_slice = {
            let mut end = vals_slice.len();
            while end > 0 && matches!(vals_slice[end - 1], b';' | b' ' | b'\t' | b'\r' | b'\n') {
                end -= 1;
            }
            &vals_slice[..end]
        };
        let tuples = split_value_tuples(vals_slice);
        if tuples.is_empty() {
            return Ok(());
        }
        // Key includes insert_prefix so INSERT INTO and INSERT IGNORE INTO stay separate.
        let key = format!("{}|{}|{}", h.insert_prefix.to_uppercase(), h.table_expr, h.columns);
        if !groups.contains_key(&key) {
            order.push(key.clone());
            groups.insert(key.clone(), (h.insert_prefix, h.table_expr, h.columns, Vec::new()));
        }
        let g = groups.get_mut(&key).unwrap();
        for t in tuples {
            g.3.push(t.to_vec());
        }
        // Flush every complete batch immediately to keep memory bounded.
        while g.3.len() >= batch_size {
            let prefix = g.0.clone();
            let te = g.1.clone();
            let col = g.2.clone();
            let chunk: Vec<Vec<u8>> = g.3.drain(..batch_size).collect();
            flush_batch(writer, &prefix, &te, &col, &chunk)?;
            *statement_count += 1;
        }
        Ok(())
    };

    for line_result in reader.lines() {
        let line = line_result.map_err(|e| e.to_string())?;
        bytes_read += line.len() as u64 + 1;
        emit_progress(&app, bytes_read, total_bytes, &mut last_percent);
        stmt_buf.push_str(&line);
        stmt_buf.push('\n');

        if line.trim_end().ends_with(';') {
            let stmt = stmt_buf.trim().to_string();
            stmt_buf.clear();
            if !stmt.is_empty() {
                process(&stmt, &mut writer, &mut order, &mut groups, &mut statement_count)?;
            }
        }
    }
    // Unterminated trailing statement
    let remaining = stmt_buf.trim().to_string();
    if !remaining.is_empty() {
        process(&remaining, &mut writer, &mut order, &mut groups, &mut statement_count)?;
    }

    // Write remaining partial batches (< batch_size) in insertion order.
    for key in &order {
        if let Some((insert_prefix, table_expr, columns, tuples)) = groups.get(key) {
            if tuples.is_empty() {
                continue;
            }
            for chunk in tuples.chunks(batch_size) {
                flush_batch(&mut writer, insert_prefix, table_expr, columns, chunk)?;
                statement_count += 1;
            }
        }
    }

    writer.flush().map_err(|e| e.to_string())?;

    Ok(MergeStats {
        table_count: groups.len(),
        statement_count,
    })
}

// ─── streaming split ────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct SplitStats {
    pub statement_count: usize,
}

/// Split batched INSERT statements back to individual single-row INSERTs.
/// Truly streaming: O(one statement) memory regardless of file size.
#[tauri::command]
pub async fn split_file(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
) -> Result<SplitStats, String> {
    let total_bytes = fs::metadata(&input_path).map(|m| m.len()).unwrap_or(0);
    let file =
        File::open(&input_path).map_err(|e| format!("无法打开文件: {}", e))?;
    let reader = BufReader::new(file);

    let out =
        File::create(&output_path).map_err(|e| format!("创建输出文件失败: {}", e))?;
    let mut writer = BufWriter::new(out);
    let mut statement_count = 0;
    let mut stmt_buf = String::new();
    let mut bytes_read: u64 = 0;
    let mut last_percent: u8 = 0;

    for line_result in reader.lines() {
        let line = line_result.map_err(|e| e.to_string())?;
        bytes_read += line.len() as u64 + 1;
        emit_progress(&app, bytes_read, total_bytes, &mut last_percent);
        stmt_buf.push_str(&line);
        stmt_buf.push('\n');

        if line.trim_end().ends_with(';') {
            let stmt = stmt_buf.trim().to_string();
            stmt_buf.clear();

            if stmt.is_empty() {
                continue;
            }

            if let Some(h) = parse_insert_header(&stmt) {
                let vals_bytes = stmt.as_bytes();
                if let Some(vals_slice) = vals_bytes.get(h.values_offset..) {
                    let vals_slice = {
                        let mut end = vals_slice.len();
                        while end > 0
                            && matches!(vals_slice[end - 1], b';' | b' ' | b'\t' | b'\r' | b'\n')
                        {
                            end -= 1;
                        }
                        &vals_slice[..end]
                    };
                    let tuples = split_value_tuples(vals_slice);
                    for tuple in &tuples {
                        writer.write_all(h.insert_prefix.as_bytes()).map_err(|e| e.to_string())?;
                        writer.write_all(b" ").map_err(|e| e.to_string())?;
                        writer.write_all(h.table_expr.as_bytes()).map_err(|e| e.to_string())?;
                        if !h.columns.is_empty() {
                            writer.write_all(b" ").map_err(|e| e.to_string())?;
                            writer.write_all(h.columns.as_bytes()).map_err(|e| e.to_string())?;
                        }
                        writer.write_all(b" VALUES ").map_err(|e| e.to_string())?;
                        writer.write_all(tuple).map_err(|e| e.to_string())?;
                        writer.write_all(b";\n").map_err(|e| e.to_string())?;
                        statement_count += 1;
                    }
                }
            }
        }
    }

    writer.flush().map_err(|e| e.to_string())?;

    Ok(SplitStats { statement_count })
}

// ─── shared helpers for new commands ──────────────────────────────────────

/// Strip backticks and schema prefix, return lowercase table name.
/// E.g. `` `db`.`User_Info` `` → `"user_info"`
fn normalize_table_name(raw: &str) -> String {
    let stripped = raw.replace('`', "");
    let parts: Vec<&str> = stripped.split('.').collect();
    parts.last().unwrap_or(&"").to_lowercase()
}

/// Escape a single CSV cell per RFC 4180.
fn csv_escape(val: &str) -> String {
    if val.contains(',') || val.contains('"') || val.contains('\n') || val.contains('\r') {
        format!("\"{}\"", val.replace('"', "\"\""))
    } else {
        val.to_string()
    }
}

/// Parse a raw SQL value token to a plain string.
/// NULL → ""; 'text' → text (un-escaping '' and \')
fn parse_sql_value(raw: &str) -> String {
    let t = raw.trim();
    if t.eq_ignore_ascii_case("NULL") {
        return String::new();
    }
    if t.starts_with('\'') && t.ends_with('\'') && t.len() >= 2 {
        return t[1..t.len() - 1]
            .replace("''", "'")
            .replace("\\'", "'");
    }
    t.to_string()
}

/// Convert a VALUES tuple byte slice `(a, 'b', NULL)` into a CSV row string.
fn tuple_to_csv_row(tuple: &[u8]) -> String {
    let s = match std::str::from_utf8(tuple) {
        Ok(s) => s,
        Err(_) => return String::new(),
    };
    let inner = if s.starts_with('(') && s.ends_with(')') {
        &s[1..s.len() - 1]
    } else {
        s
    };
    let bytes = inner.as_bytes();
    let mut tokens: Vec<String> = Vec::new();
    let mut depth: i32 = 0;
    let mut in_str = false;
    let mut start = 0usize;
    let mut i = 0usize;
    while i < bytes.len() {
        let b = bytes[i];
        if in_str {
            if b == b'\\' { i += 2; continue; }
            if b == b'\'' && i + 1 < bytes.len() && bytes[i + 1] == b'\'' { i += 2; continue; }
            if b == b'\'' { in_str = false; }
        } else {
            match b {
                b'\'' => in_str = true,
                b'(' => depth += 1,
                b')' => depth -= 1,
                b',' if depth == 0 => {
                    tokens.push(parse_sql_value(&inner[start..i]));
                    start = i + 1;
                }
                _ => {}
            }
        }
        i += 1;
    }
    tokens.push(parse_sql_value(&inner[start..]));
    tokens.iter().map(|t| csv_escape(t.as_str())).collect::<Vec<_>>().join(",")
}

// ─── streaming extract ─────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ExtractStats {
    pub matched_tables: usize,
    pub statement_count: usize,
}

/// Filter INSERT statements by table name (streaming, O(1) memory).
#[tauri::command]
pub async fn extract_by_tables(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    tables: Vec<String>,
) -> Result<ExtractStats, String> {
    // Normalize target table names for case-insensitive matching
    let target: std::collections::HashSet<String> =
        tables.iter().map(|t| normalize_table_name(t)).collect();

    let total_bytes = fs::metadata(&input_path).map(|m| m.len()).unwrap_or(0);
    let file = File::open(&input_path).map_err(|e| format!("无法打开文件: {}", e))?;
    let reader = BufReader::new(file);
    let out = File::create(&output_path).map_err(|e| format!("创建输出文件失败: {}", e))?;
    let mut writer = BufWriter::new(out);

    let mut stmt_buf = String::new();
    let mut bytes_read: u64 = 0;
    let mut last_percent: u8 = 0;
    let mut statement_count: usize = 0;
    let mut matched_set: std::collections::HashSet<String> =
        std::collections::HashSet::new();

    // Inline helper — uses macro to avoid closure mutable-borrow issues
    macro_rules! process_stmt {
        ($stmt:expr) => {{
            if let Some(h) = parse_insert_header($stmt) {
                let tname = normalize_table_name(&h.table_expr);
                if target.contains(&tname) {
                    writer.write_all($stmt.as_bytes()).map_err(|e| e.to_string())?;
                    writer.write_all(b"\n").map_err(|e| e.to_string())?;
                    statement_count += 1;
                    matched_set.insert(tname);
                }
            }
        }};
    }

    for line_result in reader.lines() {
        let line = line_result.map_err(|e| e.to_string())?;
        bytes_read += line.len() as u64 + 1;
        emit_progress(&app, bytes_read, total_bytes, &mut last_percent);
        stmt_buf.push_str(&line);
        stmt_buf.push('\n');

        if line.trim_end().ends_with(';') {
            let stmt = stmt_buf.trim().to_string();
            stmt_buf.clear();
            if !stmt.is_empty() {
                process_stmt!(&stmt);
            }
        }
    }
    let remaining = stmt_buf.trim().to_string();
    if !remaining.is_empty() {
        process_stmt!(&remaining);
    }

    writer.flush().map_err(|e| e.to_string())?;

    Ok(ExtractStats {
        matched_tables: matched_set.len(),
        statement_count,
    })
}

// ─── streaming CSV export ──────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ExportStats {
    pub table_count: usize,
    pub row_count: usize,
}

/// Export all INSERT statements from a large SQL file to per-table CSV files.
/// Streaming: O(one statement) memory regardless of file size.
#[tauri::command]
pub async fn export_to_csv_file(
    app: tauri::AppHandle,
    input_path: String,
    output_folder: String,
) -> Result<ExportStats, String> {
    let total_bytes = fs::metadata(&input_path).map(|m| m.len()).unwrap_or(0);
    let file = File::open(&input_path).map_err(|e| format!("无法打开文件: {}", e))?;
    let reader = BufReader::new(file);

    let mut table_writers: HashMap<String, BufWriter<File>> = HashMap::new();
    let mut table_has_header: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    let mut stmt_buf = String::new();
    let mut bytes_read: u64 = 0;
    let mut last_percent: u8 = 0;
    let mut row_count: usize = 0;

    // Explicit-parameter closure avoids mutable-capture borrow issues (same pattern as merge_file)
    let process_export = |stmt: &str,
                          table_writers: &mut HashMap<String, BufWriter<File>>,
                          table_has_header: &mut std::collections::HashSet<String>,
                          row_count: &mut usize,
                          output_folder: &str|
     -> Result<(), String> {
        let h = match parse_insert_header(stmt) {
            Some(h) => h,
            None => return Ok(()),
        };
        let tname = normalize_table_name(&h.table_expr);

        if !table_writers.contains_key(&tname) {
            let csv_path = Path::new(output_folder).join(format!("{}.csv", tname));
            let f = File::create(&csv_path)
                .map_err(|e| format!("创建 {}.csv 失败: {}", tname, e))?;
            table_writers.insert(tname.clone(), BufWriter::new(f));
        }

        let writer = table_writers.get_mut(&tname).unwrap();

        if !table_has_header.contains(&tname) && !h.columns.is_empty() {
            let cols_inner = h.columns.trim_start_matches('(').trim_end_matches(')');
            let header: Vec<String> = cols_inner
                .split(',')
                .map(|c| c.trim().trim_matches('`').to_string())
                .collect();
            let header_line = header
                .iter()
                .map(|c| csv_escape(c.as_str()))
                .collect::<Vec<_>>()
                .join(",");
            writer.write_all(header_line.as_bytes()).map_err(|e| e.to_string())?;
            writer.write_all(b"\r\n").map_err(|e| e.to_string())?;
            table_has_header.insert(tname.clone());
        }

        let vals_bytes = stmt.as_bytes();
        if let Some(vals_slice) = vals_bytes.get(h.values_offset..) {
            let vals_slice = {
                let mut end = vals_slice.len();
                while end > 0
                    && matches!(vals_slice[end - 1], b';' | b' ' | b'\t' | b'\r' | b'\n')
                {
                    end -= 1;
                }
                &vals_slice[..end]
            };
            for tuple in split_value_tuples(vals_slice) {
                let csv_row = tuple_to_csv_row(tuple);
                writer.write_all(csv_row.as_bytes()).map_err(|e| e.to_string())?;
                writer.write_all(b"\r\n").map_err(|e| e.to_string())?;
                *row_count += 1;
            }
        }
        Ok(())
    };

    for line_result in reader.lines() {
        let line = line_result.map_err(|e| e.to_string())?;
        bytes_read += line.len() as u64 + 1;
        emit_progress(&app, bytes_read, total_bytes, &mut last_percent);
        stmt_buf.push_str(&line);
        stmt_buf.push('\n');

        if line.trim_end().ends_with(';') {
            let stmt = stmt_buf.trim().to_string();
            stmt_buf.clear();
            if !stmt.is_empty() {
                process_export(
                    &stmt,
                    &mut table_writers,
                    &mut table_has_header,
                    &mut row_count,
                    &output_folder,
                )?;
            }
        }
    }
    let remaining = stmt_buf.trim().to_string();
    if !remaining.is_empty() {
        process_export(
            &remaining,
            &mut table_writers,
            &mut table_has_header,
            &mut row_count,
            &output_folder,
        )?;
    }

    // Flush all open writers
    for (_, mut w) in table_writers {
        w.flush().map_err(|e| e.to_string())?;
    }

    Ok(ExportStats {
        table_count: table_has_header.len(),
        row_count,
    })
}

// ─── CSV line parser ───────────────────────────────────────────────────────

/// Parse a single CSV line per RFC 4180 (handles quoted fields with embedded
/// commas and "" double-quote escaping). Does not handle multi-line quoted
/// fields — callers split on newlines first.
fn parse_csv_line(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let mut fields: Vec<String> = Vec::new();
    let mut i = 0usize;
    let mut last_was_separator = false;

    while i < bytes.len() {
        last_was_separator = false;
        if bytes[i] == b'"' {
            // Quoted field
            i += 1;
            let mut val: Vec<u8> = Vec::new();
            while i < bytes.len() {
                if bytes[i] == b'"' {
                    if i + 1 < bytes.len() && bytes[i + 1] == b'"' {
                        val.push(b'"');
                        i += 2;
                    } else {
                        i += 1; // skip closing quote
                        break;
                    }
                } else {
                    val.push(bytes[i]);
                    i += 1;
                }
            }
            fields.push(String::from_utf8_lossy(&val).to_string());
            if i < bytes.len() && bytes[i] == b',' {
                last_was_separator = true;
                i += 1;
            }
        } else {
            // Unquoted field
            let start = i;
            while i < bytes.len() && bytes[i] != b',' {
                i += 1;
            }
            fields.push(String::from_utf8_lossy(&bytes[start..i]).to_string());
            if i < bytes.len() {
                last_was_separator = true;
                i += 1; // skip comma
            }
        }
    }

    // Trailing comma → trailing empty field
    if last_was_separator {
        fields.push(String::new());
    }

    fields
}

// ─── Excel sheet scanner ───────────────────────────────────────────────────

/// Return the sheet names from an .xlsx file without reading cell data.
#[tauri::command]
pub async fn get_excel_sheets(input_path: String) -> Result<Vec<String>, String> {
    let wb: Xlsx<_> =
        open_workbook(&input_path).map_err(|e| format!("无法打开 Excel 文件: {}", e))?;
    Ok(wb.sheet_names().to_vec())
}

// ─── Shared import helpers ─────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct SheetTableMap {
    pub sheet_name: String,
    pub table_name: String,
}

#[derive(serde::Serialize)]
pub struct ImportStats {
    pub row_count: usize,
    pub table_count: usize,
}

/// Format a single Excel cell value as a SQL literal.
/// Numeric types (Float/Bool) are output without quotes; strings → single-quoted.
fn cell_to_sql(cell: &Data) -> String {
    match cell {
        Data::Empty => "NULL".to_string(),
        Data::Error(_) => "NULL".to_string(),
        Data::Bool(b) => if *b { "1" } else { "0" }.to_string(),
        Data::Float(f) => {
            // Output whole numbers without a decimal point (e.g. 30 not 30.0)
            if f.fract() == 0.0 && f.abs() < 9.0e15 {
                format!("{}", *f as i64)
            } else {
                format!("{}", f)
            }
        }
        _ => {
            let s = cell.to_string();
            if s.is_empty() {
                "NULL".to_string()
            } else {
                format!("'{}'", s.replace('\'', "''"))
            }
        }
    }
}

/// Write a batch INSERT statement (multiple value rows in one statement).
fn write_batch_insert(
    writer: &mut impl Write,
    table: &str,
    col_list: &str,
    rows: &[String],
) -> Result<(), String> {
    if rows.is_empty() {
        return Ok(());
    }
    writeln!(writer, "INSERT INTO `{}` ({}) VALUES", table, col_list)
        .map_err(|e| e.to_string())?;
    for (i, row) in rows.iter().enumerate() {
        let suffix = if i + 1 < rows.len() { "," } else { ";" };
        writeln!(writer, "  ({}){}", row, suffix).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Return true if s can be parsed as a finite f64 number.
fn is_numeric_str(s: &str) -> bool {
    s.parse::<f64>().map(|f| f.is_finite()).unwrap_or(false)
}

/// First-pass scan: determine which columns are entirely numeric.
/// Reads the file once without writing any output.
fn detect_numeric_cols(input_path: &str, no_header: bool) -> Result<Vec<bool>, String> {
    let file = File::open(input_path).map_err(|e| format!("无法打开文件: {}", e))?;
    let reader = BufReader::new(file);
    let mut is_numeric: Vec<bool> = Vec::new();
    let mut initialized = false;
    let mut first_line = true;

    for line_result in reader.lines() {
        let raw = line_result.map_err(|e| e.to_string())?;
        let stripped = raw.trim_end_matches('\r');
        let line = if first_line {
            stripped.trim_start_matches('\u{FEFF}')
        } else {
            stripped
        };
        first_line = false;

        if line.is_empty() {
            continue;
        }

        let fields = parse_csv_line(line);

        if !initialized {
            is_numeric = vec![true; fields.len()];
            initialized = true;
            if no_header {
                // First line is data — fall through to check it
            } else {
                continue; // First line is header — skip
            }
        }

        for (i, v) in fields.iter().enumerate() {
            if i < is_numeric.len() && !v.is_empty() && !is_numeric_str(v) {
                is_numeric[i] = false;
            }
        }
    }

    Ok(is_numeric)
}

// ─── Excel → SQL ───────────────────────────────────────────────────────────

/// Convert an .xlsx file to SQL INSERT statements.
/// - no_header: treat first row as data; use col1, col2, … as column names.
/// - batch_size: rows per INSERT (0 = one row per INSERT).
/// - Numeric cell types (Float, Bool) are written without quotes.
/// Progress is emitted once per sheet.
#[tauri::command]
pub async fn import_excel_to_sql(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    sheet_table_maps: Vec<SheetTableMap>,
    no_header: bool,
    batch_size: usize,
) -> Result<ImportStats, String> {
    let mut wb: Xlsx<_> =
        open_workbook(&input_path).map_err(|e| format!("无法打开 Excel 文件: {}", e))?;
    let out =
        File::create(&output_path).map_err(|e| format!("创建输出文件失败: {}", e))?;
    let mut writer = BufWriter::new(out);
    let mut total_rows = 0usize;
    let total_sheets = sheet_table_maps.len();

    for (sheet_idx, map) in sheet_table_maps.iter().enumerate() {
        let range = match wb.worksheet_range(&map.sheet_name) {
            Ok(r) => r,
            Err(e) => {
                return Err(format!("读取 Sheet '{}' 失败: {}", map.sheet_name, e))
            }
        };

        let mut rows_iter = range.rows();
        let safe_table = map.table_name.replace('`', "");

        let headers: Vec<String> = if no_header {
            let (_, width) = range.get_size();
            (1..=width).map(|i| format!("col{}", i)).collect()
        } else {
            match rows_iter.next() {
                Some(row) => row
                    .iter()
                    .map(|c: &Data| c.to_string().replace('`', ""))
                    .collect(),
                None => continue,
            }
        };
        if headers.is_empty() {
            continue;
        }

        let col_list = headers
            .iter()
            .map(|h| format!("`{}`", h))
            .collect::<Vec<_>>()
            .join(", ");

        let mut batch: Vec<String> = Vec::new();

        for row in rows_iter {
            if row.iter().all(|c| *c == Data::Empty) {
                continue;
            }

            let val_list = (0..headers.len())
                .map(|i| match row.get(i) {
                    None | Some(Data::Empty) => "NULL".to_string(),
                    Some(cell) => cell_to_sql(cell),
                })
                .collect::<Vec<_>>()
                .join(", ");

            if batch_size == 0 {
                writeln!(
                    writer,
                    "INSERT INTO `{}` ({}) VALUES ({});",
                    safe_table, col_list, val_list
                )
                .map_err(|e| e.to_string())?;
            } else {
                batch.push(val_list);
                if batch.len() >= batch_size {
                    write_batch_insert(&mut writer, &safe_table, &col_list, &batch)?;
                    batch.clear();
                }
            }
            total_rows += 1;
        }

        if !batch.is_empty() {
            write_batch_insert(&mut writer, &safe_table, &col_list, &batch)?;
        }

        let percent = ((sheet_idx + 1) as f64 / total_sheets as f64 * 100.0) as u8;
        app.emit("stream-progress", ProgressEvent { percent }).ok();
    }

    writer.flush().map_err(|e| e.to_string())?;

    Ok(ImportStats {
        row_count: total_rows,
        table_count: total_sheets,
    })
}

// ─── CSV → SQL (streaming) ─────────────────────────────────────────────────

/// Stream a large CSV file to SQL INSERT statements.
/// - no_header: treat first row as data; column names become col1, col2, …
/// - batch_size: rows per INSERT (0 = one row per INSERT).
/// - detect_numeric: two-pass scan — first pass determines which columns are
///   all-numeric, second pass writes SQL with unquoted numbers.
#[tauri::command]
pub async fn import_csv_to_sql(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    table_name: String,
    no_header: bool,
    batch_size: usize,
    detect_numeric: bool,
) -> Result<ImportStats, String> {
    let safe_table = table_name.replace('`', "");
    let total_bytes = fs::metadata(&input_path).map(|m| m.len()).unwrap_or(0);

    // Pass 1 (optional): determine which columns are all-numeric.
    let numeric_cols: Vec<bool> = if detect_numeric {
        detect_numeric_cols(&input_path, no_header)?
    } else {
        Vec::new()
    };

    // Pass 2: stream the file and write SQL.
    let file = File::open(&input_path).map_err(|e| format!("无法打开文件: {}", e))?;
    let reader = BufReader::new(file);
    let out =
        File::create(&output_path).map_err(|e| format!("创建输出文件失败: {}", e))?;
    let mut writer = BufWriter::new(out);

    let mut bytes_read: u64 = 0;
    let mut last_percent: u8 = 0;
    let mut row_count = 0usize;
    let mut col_list = String::new();
    let mut col_count = 0usize;
    let mut header_done = false;
    let mut first_line = true;
    let mut batch: Vec<String> = Vec::new();

    for line_result in reader.lines() {
        let raw = line_result.map_err(|e| e.to_string())?;
        bytes_read += raw.len() as u64 + 1;
        emit_progress(&app, bytes_read, total_bytes, &mut last_percent);

        let stripped = raw.trim_end_matches('\r');
        let line = if first_line {
            stripped.trim_start_matches('\u{FEFF}')
        } else {
            stripped
        };
        first_line = false;

        if line.is_empty() {
            continue;
        }

        let fields = parse_csv_line(line);

        if !header_done {
            if no_header {
                // First data line: generate col1, col2, … and fall through to write it
                col_count = fields.len();
                col_list = (1..=col_count)
                    .map(|i| format!("`col{}`", i))
                    .collect::<Vec<_>>()
                    .join(", ");
            } else {
                // Header line: build col_list and skip to next line
                col_count = fields.len();
                col_list = fields
                    .iter()
                    .map(|h| format!("`{}`", h.replace('`', "")))
                    .collect::<Vec<_>>()
                    .join(", ");
                header_done = true;
                continue;
            }
            header_done = true;
        }

        let val_list = (0..col_count)
            .map(|i| {
                let v = fields.get(i).map(|s| s.as_str()).unwrap_or("");
                if v.is_empty() {
                    "NULL".to_string()
                } else if detect_numeric && numeric_cols.get(i).copied().unwrap_or(false) {
                    v.to_string()
                } else {
                    format!("'{}'", v.replace('\'', "''"))
                }
            })
            .collect::<Vec<_>>()
            .join(", ");

        if batch_size == 0 {
            writeln!(
                writer,
                "INSERT INTO `{}` ({}) VALUES ({});",
                safe_table, col_list, val_list
            )
            .map_err(|e| e.to_string())?;
        } else {
            batch.push(val_list);
            if batch.len() >= batch_size {
                write_batch_insert(&mut writer, &safe_table, &col_list, &batch)?;
                batch.clear();
            }
        }
        row_count += 1;
    }

    if !batch.is_empty() {
        write_batch_insert(&mut writer, &safe_table, &col_list, &batch)?;
    }

    writer.flush().map_err(|e| e.to_string())?;

    Ok(ImportStats {
        row_count,
        table_count: 1,
    })
}

// ─── dedupe_sql ────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct DedupeStats {
    pub original_count: usize,
    pub kept_count: usize,
    pub removed_count: usize,
}

/// Extract the dedup key from a VALUES (...) string.
/// Returns the raw token at `col_index` (0-based) or None.
fn extract_key_from_values(values_str: &str, col_index: usize) -> Option<String> {
    let mut tokens: Vec<String> = Vec::new();
    let chars: Vec<char> = values_str.chars().collect();
    let mut i = 0;

    while i < chars.len() {
        // skip whitespace
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }

        if chars[i] == '\'' {
            // single-quoted string with '' escaping
            let mut token = String::from("'");
            i += 1;
            loop {
                if i >= chars.len() {
                    break;
                }
                if chars[i] == '\'' {
                    token.push('\'');
                    i += 1;
                    if i < chars.len() && chars[i] == '\'' {
                        token.push('\'');
                        i += 1;
                    } else {
                        break;
                    }
                } else {
                    token.push(chars[i]);
                    i += 1;
                }
            }
            tokens.push(token);
        } else {
            // unquoted token (NULL, number, identifier)
            let mut token = String::new();
            while i < chars.len() && chars[i] != ',' && !chars[i].is_whitespace() {
                token.push(chars[i]);
                i += 1;
            }
            tokens.push(token);
        }

        // skip whitespace then comma
        while i < chars.len() && chars[i].is_whitespace() {
            i += 1;
        }
        if i < chars.len() && chars[i] == ',' {
            i += 1;
        }
    }

    tokens.into_iter().nth(col_index)
}

/// Parse one INSERT line to extract (table_name, key_value).
/// Returns None for non-INSERT lines or parse failures.
fn parse_insert_key(
    line: &str,
    key_column: Option<&str>,
    key_col_index: Option<usize>, // 1-based
) -> Option<(String, String)> {
    // Crude but fast: look for INSERT INTO pattern
    let upper = line.to_uppercase();
    let into_pos = upper.find("INSERT")?;
    let rest = &line[into_pos..];

    // Skip "INSERT" then whitespace
    let rest = rest[6..].trim_start();
    if !rest.to_uppercase().starts_with("INTO") {
        return None;
    }
    let rest = rest[4..].trim_start();

    // Table name (optionally backtick-quoted)
    let (table_name, rest) = if rest.starts_with('`') {
        let end = rest[1..].find('`')? + 1;
        (rest[1..end].to_string(), rest[end + 1..].trim_start())
    } else {
        let end = rest.find(|c: char| c.is_whitespace() || c == '(' || c == '`')?;
        (rest[..end].to_string(), rest[end..].trim_start())
    };

    // Optional column list
    let mut col_idx: Option<usize> = None;
    let rest = if rest.starts_with('(') && !rest.to_uppercase().contains("VALUES") {
        // Check if this is a column list (before VALUES)
        let values_pos = rest.to_uppercase().find("VALUES")?;
        let col_section = &rest[1..]; // skip opening '('
        if let Some(close) = col_section.find(')') {
            if close < values_pos {
                // It's a column list
                if let Some(col_name) = key_column {
                    let cols: Vec<&str> = col_section[..close]
                        .split(',')
                        .map(|c| c.trim().trim_matches('`'))
                        .collect();
                    col_idx = cols
                        .iter()
                        .position(|c| c.eq_ignore_ascii_case(col_name));
                }
                rest[close + 2..].trim_start() // skip ') '
            } else {
                rest
            }
        } else {
            rest
        }
    } else {
        // No column list — use key_col_index
        if let Some(idx) = key_col_index {
            col_idx = Some(idx - 1); // convert 1-based to 0-based
        }
        rest
    };

    // Find VALUES (
    let values_pos = rest.to_uppercase().find("VALUES")?;
    let after_values = rest[values_pos + 6..].trim_start();
    if !after_values.starts_with('(') {
        return None;
    }
    let values_inner = &after_values[1..];
    let close = values_inner.rfind(')')?;
    let values_str = &values_inner[..close];

    let effective_col_idx = col_idx?;
    let key_val = extract_key_from_values(values_str, effective_col_idx)?;

    Some((table_name, key_val))
}

#[tauri::command]
pub async fn dedupe_sql(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    key_column: Option<String>,
    key_col_index: Option<usize>, // 1-based
    keep_last: bool,
) -> Result<DedupeStats, String> {
    let total_bytes = std::fs::metadata(&input_path)
        .map(|m| m.len())
        .unwrap_or(0);

    // Pass 1: build map from (table, key_value) → line_number
    let file1 = File::open(&input_path).map_err(|e| e.to_string())?;
    let reader1 = BufReader::new(file1);
    let mut key_to_line: HashMap<(String, String), usize> = HashMap::new();
    let mut original_count = 0usize;
    let mut bytes_read: u64 = 0;
    let mut last_percent: u8 = 0;

    for (line_no, line_res) in reader1.lines().enumerate() {
        let line = line_res.map_err(|e| e.to_string())?;
        bytes_read += line.len() as u64 + 1;
        emit_progress(&app, bytes_read, total_bytes, &mut last_percent);

        let trimmed = line.trim_end();
        let upper = trimmed.to_uppercase();
        if !upper.contains("INSERT") {
            continue;
        }

        if let Some((table, key)) = parse_insert_key(
            trimmed,
            key_column.as_deref(),
            key_col_index,
        ) {
            original_count += 1;
            let composite = (table, key);
            if !key_to_line.contains_key(&composite) || keep_last {
                key_to_line.insert(composite, line_no);
            }
        }
    }

    let kept_lines: std::collections::HashSet<usize> =
        key_to_line.values().copied().collect();

    // Pass 2: write kept lines
    let file2 = File::open(&input_path).map_err(|e| e.to_string())?;
    let reader2 = BufReader::new(file2);
    let out_file = File::create(&output_path).map_err(|e| e.to_string())?;
    let mut writer = BufWriter::new(out_file);

    bytes_read = 0;
    last_percent = 0;
    let mut kept_count = 0usize;

    for (line_no, line_res) in reader2.lines().enumerate() {
        let line = line_res.map_err(|e| e.to_string())?;
        bytes_read += line.len() as u64 + 1;
        emit_progress(&app, bytes_read, total_bytes, &mut last_percent);

        let trimmed = line.trim_end();
        let upper = trimmed.to_uppercase();

        if upper.contains("INSERT") && parse_insert_key(trimmed, key_column.as_deref(), key_col_index).is_some() {
            if kept_lines.contains(&line_no) {
                writeln!(writer, "{}", trimmed).map_err(|e| e.to_string())?;
                kept_count += 1;
            }
        } else {
            writeln!(writer, "{}", trimmed).map_err(|e| e.to_string())?;
        }
    }

    writer.flush().map_err(|e| e.to_string())?;

    let removed_count = original_count - kept_count;
    Ok(DedupeStats {
        original_count,
        kept_count,
        removed_count,
    })
}

// ─── shared helpers ────────────────────────────────────────────────────────

fn tokenize_sql_values(s: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        while i < chars.len() && chars[i].is_whitespace() { i += 1; }
        if i >= chars.len() { break; }
        if chars[i] == '\'' {
            let mut tok = String::from("'");
            i += 1;
            loop {
                if i >= chars.len() { break; }
                if chars[i] == '\'' {
                    tok.push('\'');
                    i += 1;
                    if i < chars.len() && chars[i] == '\'' {
                        tok.push('\'');
                        i += 1;
                    } else { break; }
                } else {
                    tok.push(chars[i]);
                    i += 1;
                }
            }
            tokens.push(tok);
        } else {
            let mut tok = String::new();
            while i < chars.len() && chars[i] != ',' && !chars[i].is_whitespace() {
                tok.push(chars[i]);
                i += 1;
            }
            tokens.push(tok);
        }
        while i < chars.len() && chars[i].is_whitespace() { i += 1; }
        if i < chars.len() && chars[i] == ',' { i += 1; }
    }
    tokens
}

/// Parse INSERT INTO line → (table_name, Option<Vec<col>>, Vec<value>)
fn parse_insert_parts(line: &str) -> Option<(String, Option<Vec<String>>, Vec<String>)> {
    let upper = line.to_uppercase();
    let insert_pos = upper.find("INSERT")?;
    let rest = line[insert_pos + 6..].trim_start();
    if !rest.to_uppercase().starts_with("INTO") { return None; }
    let rest = rest[4..].trim_start();

    // Table name
    let (table, rest) = if rest.starts_with('`') {
        let end = rest[1..].find('`')? + 1;
        (rest[1..end].to_string(), rest[end + 1..].trim_start())
    } else {
        let end = rest.find(|c: char| c.is_whitespace() || c == '(')?;
        (rest[..end].to_string(), rest[end..].trim_start())
    };

    let upper_rest = rest.to_uppercase();
    let values_pos = upper_rest.find("VALUES")?;
    let before_values = &rest[..values_pos];

    let columns = if before_values.trim_start().starts_with('(') {
        let inner = before_values.trim_start();
        let close = inner.rfind(')')?;
        let cols: Vec<String> = inner[1..close]
            .split(',')
            .map(|c| c.trim().trim_matches('`').to_string())
            .collect();
        Some(cols)
    } else {
        None
    };

    let after_values = rest[values_pos + 6..].trim_start();
    if !after_values.starts_with('(') { return None; }
    let inner = &after_values[1..];
    let close = inner.rfind(')')?;
    let values_str = &inner[..close];
    let values = tokenize_sql_values(values_str);

    Some((table, columns, values))
}

// ─── rename_sql ────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct RenameRuleInput {
    pub rule_type: String,
    pub from: String,
    pub to: String,
}

#[derive(serde::Serialize)]
pub struct RenameStats {
    pub replaced_count: usize,
}

fn apply_rename_line(line: &str, rules: &[RenameRuleInput]) -> (String, bool) {
    let upper = line.to_uppercase();
    if !upper.contains("INSERT") {
        return (line.to_string(), false);
    }
    let mut result = line.to_string();
    let mut modified = false;

    for rule in rules {
        if rule.from == rule.to || rule.from.is_empty() { continue; }
        let escaped = regex::escape(&rule.from);
        let new_line = match rule.rule_type.as_str() {
            "table" => {
                // Replace table name: INSERT INTO `from` or INSERT INTO from
                let re_str = format!(
                    r"(?i)(INSERT\s+INTO\s+)(`{escaped}`|(?<![`\w]){escaped}(?![`\w]))"
                );
                if let Ok(re) = regex::Regex::new(&re_str) {
                    let to = rule.to.clone();
                    re.replace(&result, move |caps: &regex::Captures| {
                        format!("{}`{}`", &caps[1], to)
                    }).to_string()
                } else { result.clone() }
            }
            "prefix" => {
                let re_str = format!(
                    r"(?i)(INSERT\s+INTO\s+)(`{escaped}([^`\s]*)`|(?<![`\w]){escaped}(\S*?)(?![`\w(]))"
                );
                if let Ok(re) = regex::Regex::new(&re_str) {
                    let to = rule.to.clone();
                    re.replace(&result, move |caps: &regex::Captures| {
                        let pfx = &caps[1];
                        let rest = caps.get(3).or(caps.get(4)).map_or("", |m| m.as_str());
                        format!("{}`{}{}`", pfx, to, rest)
                    }).to_string()
                } else { result.clone() }
            }
            "column" => {
                // Replace only inside the column list section (before VALUES)
                let upper_res = result.to_uppercase();
                if let Some(val_pos) = upper_res.find("VALUES") {
                    let before_values = &result[..val_pos];
                    if let Some(open) = before_values.find('(') {
                        if let Some(close) = before_values.rfind(')') {
                            let col_section = &before_values[open + 1..close];
                            let re_str = format!(
                                r"(?i)(`{escaped}`|(?<![`\w]){escaped}(?![`\w]))"
                            );
                            if let Ok(re) = regex::Regex::new(&re_str) {
                                let to = rule.to.clone();
                                let new_cols = re.replace_all(col_section, move |_caps: &regex::Captures| {
                                    format!("`{}`", to)
                                }).to_string();
                                format!(
                                    "{}{}{}{}",
                                    &before_values[..open + 1],
                                    new_cols,
                                    &before_values[close..],
                                    &result[val_pos..]
                                )
                            } else { result.clone() }
                        } else { result.clone() }
                    } else { result.clone() }
                } else { result.clone() }
            }
            _ => result.clone(),
        };
        if new_line != result { modified = true; result = new_line; }
    }
    (result, modified)
}

#[tauri::command]
pub async fn rename_sql(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    rules: Vec<RenameRuleInput>,
) -> Result<RenameStats, String> {
    let total_bytes = std::fs::metadata(&input_path).map(|m| m.len()).unwrap_or(0);
    let file = File::open(&input_path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let out_file = File::create(&output_path).map_err(|e| e.to_string())?;
    let mut writer = BufWriter::new(out_file);

    let mut bytes_read: u64 = 0;
    let mut last_percent: u8 = 0;
    let mut replaced_count = 0usize;

    for line_res in reader.lines() {
        let line = line_res.map_err(|e| e.to_string())?;
        bytes_read += line.len() as u64 + 1;
        emit_progress(&app, bytes_read, total_bytes, &mut last_percent);
        let (new_line, modified) = apply_rename_line(line.trim_end(), &rules);
        if modified { replaced_count += 1; }
        writeln!(writer, "{}", new_line).map_err(|e| e.to_string())?;
    }
    writer.flush().map_err(|e| e.to_string())?;
    Ok(RenameStats { replaced_count })
}

// ─── offset_sql ────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct OffsetRuleInput {
    pub column: String,
    pub col_index: Option<usize>,
    pub offset: i64,
}

#[derive(serde::Serialize)]
pub struct OffsetStats {
    pub modified_count: usize,
    pub skipped_count: usize,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub async fn offset_sql(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    rules: Vec<OffsetRuleInput>,
) -> Result<OffsetStats, String> {
    let total_bytes = std::fs::metadata(&input_path).map(|m| m.len()).unwrap_or(0);
    let file = File::open(&input_path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let out_file = File::create(&output_path).map_err(|e| e.to_string())?;
    let mut writer = BufWriter::new(out_file);

    let mut bytes_read: u64 = 0;
    let mut last_percent: u8 = 0;
    let mut modified_count = 0usize;
    let mut skipped_count = 0usize;
    let mut warning_set: std::collections::HashSet<String> = std::collections::HashSet::new();

    for line_res in reader.lines() {
        let line = line_res.map_err(|e| e.to_string())?;
        bytes_read += line.len() as u64 + 1;
        emit_progress(&app, bytes_read, total_bytes, &mut last_percent);
        let trimmed = line.trim_end();

        if let Some((table, columns, mut values)) = parse_insert_parts(trimmed) {
            let mut line_modified = false;
            let mut line_skipped = false;

            for rule in &rules {
                let idx = if !rule.column.is_empty() {
                    if let Some(cols) = &columns {
                        cols.iter().position(|c| c.to_lowercase() == rule.column.to_lowercase())
                    } else { rule.col_index.map(|i| i - 1) }
                } else { rule.col_index.map(|i| i - 1) };

                if let Some(i) = idx {
                    if i >= values.len() { continue; }
                    let raw = &values[i];
                    if raw.starts_with('\'') {
                        line_skipped = true;
                        warning_set.insert(format!("列 \"{}\" 存在非数值，已跳过偏移", rule.column));
                        continue;
                    }
                    if let Ok(n) = raw.parse::<i64>() {
                        values[i] = (n + rule.offset).to_string();
                        line_modified = true;
                    } else if let Ok(f) = raw.parse::<f64>() {
                        values[i] = format!("{}", f + rule.offset as f64);
                        line_modified = true;
                    } else {
                        line_skipped = true;
                        warning_set.insert(format!("列 \"{}\" 存在非数值，已跳过偏移", rule.column));
                    }
                }
            }

            if line_skipped { skipped_count += 1; }
            if line_modified {
                modified_count += 1;
                let col_part = if let Some(cols) = &columns {
                    format!(" ({})", cols.iter().map(|c| format!("`{}`", c)).collect::<Vec<_>>().join(", "))
                } else { String::new() };
                writeln!(writer, "INSERT INTO `{}`{} VALUES ({});", table, col_part, values.join(", "))
                    .map_err(|e| e.to_string())?;
            } else {
                writeln!(writer, "{}", trimmed).map_err(|e| e.to_string())?;
            }
        } else {
            writeln!(writer, "{}", trimmed).map_err(|e| e.to_string())?;
        }
    }

    writer.flush().map_err(|e| e.to_string())?;
    Ok(OffsetStats {
        modified_count,
        skipped_count,
        warnings: warning_set.into_iter().collect(),
    })
}

// ─── analyze_sql_file ──────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct TableStatItem {
    pub table_name: String,
    pub row_count: usize,
    pub estimated_bytes: usize,
}

#[derive(serde::Serialize)]
pub struct SqlFileStats {
    pub tables: Vec<TableStatItem>,
    pub total_rows: usize,
    pub total_statements: usize,
    pub input_bytes: u64,
    pub duration_ms: u64,
}

#[tauri::command]
pub async fn analyze_sql_file(
    app: tauri::AppHandle,
    input_path: String,
) -> Result<SqlFileStats, String> {
    let start = std::time::Instant::now();
    let total_bytes = std::fs::metadata(&input_path).map(|m| m.len()).unwrap_or(0);
    let file = File::open(&input_path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);

    let mut table_map: HashMap<String, (usize, usize)> = HashMap::new();
    let mut bytes_read: u64 = 0;
    let mut last_percent: u8 = 0;

    for line_res in reader.lines() {
        let line = line_res.map_err(|e| e.to_string())?;
        let line_len = line.len() + 1;
        bytes_read += line_len as u64;
        emit_progress(&app, bytes_read, total_bytes, &mut last_percent);
        let trimmed = line.trim_end();
        let upper = trimmed.to_uppercase();
        if !upper.contains("INSERT") { continue; }

        // Fast table name extraction
        if let Some(m) = {
            let re = regex::Regex::new(r"(?i)INSERT\s+INTO\s+`?([^`\s(]+)`?").ok();
            re.and_then(|r| r.captures(trimmed))
        } {
            if let Some(tname) = m.get(1) {
                let entry = table_map.entry(tname.as_str().to_string()).or_insert((0, 0));
                entry.0 += 1;
                entry.1 += line_len;
            }
        }
    }

    let total_statements: usize = table_map.values().map(|(c, _)| c).sum();
    let tables: Vec<TableStatItem> = table_map
        .into_iter()
        .map(|(name, (count, bytes))| TableStatItem {
            table_name: name,
            row_count: count,
            estimated_bytes: bytes,
        })
        .collect();

    Ok(SqlFileStats {
        tables,
        total_rows: total_statements,
        total_statements,
        input_bytes: total_bytes,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

// ─── convert_statements ────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ConvertStmtStats {
    pub converted_count: usize,
    pub skipped_count: usize,
}

#[tauri::command]
pub async fn convert_statements(
    app: tauri::AppHandle,
    input_path: String,
    output_path: String,
    mode: String,
    pk_column: String,
    exclude_columns: Vec<String>,
) -> Result<ConvertStmtStats, String> {
    let total_bytes = std::fs::metadata(&input_path).map(|m| m.len()).unwrap_or(0);
    let file = File::open(&input_path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(file);
    let out_file = File::create(&output_path).map_err(|e| e.to_string())?;
    let mut writer = BufWriter::new(out_file);

    let mut bytes_read: u64 = 0;
    let mut last_percent: u8 = 0;
    let mut converted_count = 0usize;
    let mut skipped_count = 0usize;
    let exclude_set: std::collections::HashSet<String> =
        exclude_columns.iter().map(|c| c.to_lowercase()).collect();

    for line_res in reader.lines() {
        let line = line_res.map_err(|e| e.to_string())?;
        bytes_read += line.len() as u64 + 1;
        emit_progress(&app, bytes_read, total_bytes, &mut last_percent);
        let trimmed = line.trim_end();
        let upper = trimmed.to_uppercase();

        if !upper.contains("INSERT") {
            writeln!(writer, "{}", trimmed).map_err(|e| e.to_string())?;
            continue;
        }

        if let Some((table, Some(cols), values)) = parse_insert_parts(trimmed) {
            let pk_idx = cols.iter().position(|c| c.to_lowercase() == pk_column.to_lowercase());
            let pk_idx = match pk_idx {
                Some(i) => i,
                None => {
                    skipped_count += 1;
                    writeln!(writer, "{}", trimmed).map_err(|e| e.to_string())?;
                    continue;
                }
            };

            let pk_val = values.get(pk_idx).map(|s| s.as_str()).unwrap_or("NULL");
            let pk_col = &cols[pk_idx];

            let converted = match mode.as_str() {
                "update" => {
                    let set_parts: Vec<String> = cols.iter().enumerate()
                        .filter(|(i, c)| *i != pk_idx && !exclude_set.contains(&c.to_lowercase()))
                        .map(|(i, c)| format!("`{}` = {}", c, values.get(i).map(|s| s.as_str()).unwrap_or("NULL")))
                        .collect();
                    if set_parts.is_empty() {
                        skipped_count += 1;
                        writeln!(writer, "{}", trimmed).map_err(|e| e.to_string())?;
                        continue;
                    }
                    format!("UPDATE `{}` SET {} WHERE `{}` = {};", table, set_parts.join(", "), pk_col, pk_val)
                }
                "mysql_upsert" => {
                    let col_list = cols.iter().map(|c| format!("`{}`", c)).collect::<Vec<_>>().join(", ");
                    let val_list = values.join(", ");
                    let update_parts: Vec<String> = cols.iter().enumerate()
                        .filter(|(i, c)| *i != pk_idx && !exclude_set.contains(&c.to_lowercase()))
                        .map(|(_, c)| format!("`{}` = VALUES(`{}`)", c, c))
                        .collect();
                    format!("INSERT INTO `{}` ({}) VALUES ({}) ON DUPLICATE KEY UPDATE {};",
                        table, col_list, val_list, update_parts.join(", "))
                }
                "pg_upsert" | _ => {
                    let col_list = cols.iter().map(|c| format!("\"{}\"", c)).collect::<Vec<_>>().join(", ");
                    let val_list = values.join(", ");
                    let update_parts: Vec<String> = cols.iter().enumerate()
                        .filter(|(i, c)| *i != pk_idx && !exclude_set.contains(&c.to_lowercase()))
                        .map(|(_, c)| format!("\"{}\" = EXCLUDED.\"{}\"", c, c))
                        .collect();
                    format!("INSERT INTO \"{}\" ({}) VALUES ({}) ON CONFLICT (\"{}\") DO UPDATE SET {};",
                        table, col_list, val_list, pk_col, update_parts.join(", "))
                }
            };

            converted_count += 1;
            writeln!(writer, "{}", converted).map_err(|e| e.to_string())?;
        } else {
            skipped_count += 1;
            writeln!(writer, "{}", trimmed).map_err(|e| e.to_string())?;
        }
    }

    writer.flush().map_err(|e| e.to_string())?;
    Ok(ConvertStmtStats { converted_count, skipped_count })
}

// ─── merge_sql_files ───────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct MergeFilesStats {
    pub total_lines: usize,
}

#[tauri::command]
pub async fn merge_sql_files(
    app: tauri::AppHandle,
    input_paths: Vec<String>,
    output_path: String,
    dedup_sets: bool,
    add_separator: bool,
) -> Result<MergeFilesStats, String> {
    // Compute total bytes for progress
    let total_bytes: u64 = input_paths
        .iter()
        .map(|p| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0))
        .sum();

    let out_file = File::create(&output_path).map_err(|e| e.to_string())?;
    let mut writer = BufWriter::new(out_file);

    let mut seen_sets: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut bytes_read: u64 = 0;
    let mut last_percent: u8 = 0;
    let mut total_lines = 0usize;

    for (file_idx, input_path) in input_paths.iter().enumerate() {
        if add_separator {
            let fname = std::path::Path::new(input_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(input_path.as_str());
            writeln!(writer, "-- === file: {} ===", fname)
                .map_err(|e| e.to_string())?;
            total_lines += 1;
        }

        let file = File::open(input_path).map_err(|e| e.to_string())?;
        let reader = BufReader::new(file);

        for line_res in reader.lines() {
            let line = line_res.map_err(|e| e.to_string())?;
            bytes_read += line.len() as u64 + 1;
            emit_progress(&app, bytes_read, total_bytes, &mut last_percent);

            let trimmed = line.trim_end();

            // Dedup SET statements (e.g. SET NAMES utf8mb4)
            if dedup_sets && trimmed.to_uppercase().trim_start().starts_with("SET ") {
                let key = trimmed.to_string();
                if seen_sets.contains(&key) {
                    continue; // skip duplicate
                }
                seen_sets.insert(key);
            }

            // Skip empty separator lines between files (not at first file)
            // to avoid double-blank-lines when files have trailing newlines.
            // Only collapse: keep at most one consecutive blank line.
            writeln!(writer, "{}", trimmed).map_err(|e| e.to_string())?;
            total_lines += 1;
        }

        // Blank line between files for readability (unless last file)
        if file_idx < input_paths.len() - 1 {
            writeln!(writer).map_err(|e| e.to_string())?;
        }
    }

    writer.flush().map_err(|e| e.to_string())?;
    Ok(MergeFilesStats { total_lines })
}

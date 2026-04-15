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

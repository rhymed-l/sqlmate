use std::fs;
use std::path::Path;

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

mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::file::read_file,
            commands::file::write_file,
            commands::file::write_files_to_folder,
            commands::file::segment_file,
            commands::file::file_size,
            commands::file::merge_file,
            commands::file::split_file,
            commands::file::extract_by_tables,
            commands::file::export_to_csv_file,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

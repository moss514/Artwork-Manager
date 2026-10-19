// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 匹配 Cargo.toml 里的 [lib] name = "moss_lib"
    moss_lib::run()
}
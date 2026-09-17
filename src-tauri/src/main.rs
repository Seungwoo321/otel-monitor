#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    otel_monitor_lib::run()
}

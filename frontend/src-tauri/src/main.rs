// Windows release 版不要額外開一個主控台視窗,請勿刪除!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    kefu_lib::run()
}

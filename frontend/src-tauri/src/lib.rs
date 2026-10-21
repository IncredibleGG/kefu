// kefu 桌面殼(Tauri 2:Windows、macOS)
//
// 職責:
// - 外掛註冊:single-instance 必須第一個(第二個實例的 kefu:// 參數經它轉交 deep-link),
//   其餘為 deep-link、notification、opener、os、process、store、dialog、fs、window-state、autostart。
// - 系統匣:左鍵切換主視窗、選單「開啟 kefu / 結束」;關閉視窗 = 縮到系統匣,只有「結束」才真正退出。
// - 指令 `set_unread(count)`:系統匣提示、macOS Dock 角標、Windows 工作列疊加紅點,
//   未讀增加且視窗不在前景時請求使用者注意(Dock 跳一下 / 工作列閃爍)。
// - 指令 `show_main_window()`:前端(例如點通知)要求把主視窗叫到前景。
//
// 介面契約見 docs/NATIVE-CLIENTS.md 第 3、5 節。

use std::sync::Mutex;

use tauri::{AppHandle, Manager, State, UserAttentionType, WebviewWindow, WindowEvent};

#[cfg(target_os = "macos")]
use tauri::RunEvent;

#[cfg(desktop)]
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

/// 主視窗 label(與 tauri.conf.json、capabilities/default.json 一致)
const MAIN_WINDOW: &str = "main";
/// 系統匣圖示 id
const TRAY_ID: &str = "kefu-tray";
/// 開機自動啟動時帶的參數:有它就只常駐系統匣、不彈出主視窗
const AUTOSTART_ARG: &str = "--autostart";
/// 系統匣選單項目 id
const MENU_SHOW: &str = "show";
const MENU_QUIT: &str = "quit";

/// macOS 選單列模板圖(單色黑 + 透明,系統依明暗自動反白);64px 供 Retina 使用
#[cfg(all(desktop, target_os = "macos"))]
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/tray@2x.png");
/// Windows / Linux 系統匣用彩色 App 圖示(單色黑模板圖在深色工作列上會看不見)
#[cfg(all(desktop, not(target_os = "macos")))]
const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/32x32.png");
/// Windows 工作列疊加圖示:16x16 紅點
#[cfg(target_os = "windows")]
const BADGE_DOT_PNG: &[u8] = include_bytes!("../icons/badge-dot.png");

/// 目前未讀數(用來判斷「增加」才請求注意,以及重新顯示視窗時補回工作列疊加圖示)
#[derive(Default)]
struct UnreadState(Mutex<u32>);

/// 系統匣提示文字
fn tray_tooltip(count: u32) -> String {
    if count > 0 {
        format!("kefu · {count} 則未讀")
    } else {
        "kefu".to_string()
    }
}

/// 套用未讀數到系統匣與工作列 / Dock(錯誤一律忽略:顯示失敗不應讓前端的 invoke 失敗)
fn apply_unread(app: &AppHandle, window: Option<&WebviewWindow>, count: u32) {
    #[cfg(desktop)]
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let _ = tray.set_tooltip(Some(tray_tooltip(count)));
    }
    #[cfg(not(desktop))]
    let _ = app;

    let Some(window) = window else { return };

    // macOS(與 Linux)Dock / 啟動器角標;None 代表清除。Windows 不支援,改用疊加圖示。
    #[cfg(not(target_os = "windows"))]
    let _ = window.set_badge_count(if count > 0 {
        Some(i64::from(count))
    } else {
        None
    });

    #[cfg(target_os = "windows")]
    {
        let overlay = if count > 0 {
            Image::from_bytes(BADGE_DOT_PNG).ok()
        } else {
            None
        };
        let _ = window.set_overlay_icon(overlay);
    }
}

/// 把主視窗叫到前景:取消最小化 → 顯示 → 聚焦
fn reveal_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();

    // Windows 隱藏再顯示後工作列按鈕會重建,疊加圖示可能遺失,依目前未讀數補回
    #[cfg(target_os = "windows")]
    if let Some(state) = app.try_state::<UnreadState>() {
        let count = state.0.lock().map(|c| *c).unwrap_or(0);
        apply_unread(app, Some(&window), count);
    }
}

/// 系統匣左鍵:主視窗在前景就藏起來,否則叫出來
#[cfg(desktop)]
fn toggle_main_window(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let minimized = window.is_minimized().unwrap_or(false);
    // Windows 點系統匣時焦點會先跑到工作列,所以只看「可見且未最小化」;
    // macOS 點選單列不會搶焦點,可以多看「是否聚焦」,避免視窗被別的 App 蓋住時反而被藏起來。
    #[cfg(target_os = "macos")]
    let in_front = visible && !minimized && window.is_focused().unwrap_or(false);
    #[cfg(not(target_os = "macos"))]
    let in_front = visible && !minimized;

    if in_front {
        let _ = window.hide();
    } else {
        reveal_main_window(app);
    }
}

/// 建立系統匣圖示與選單
#[cfg(desktop)]
fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, MENU_SHOW, "開啟 kefu", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "結束", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &separator, &quit])?;

    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(Image::from_bytes(TRAY_ICON_PNG)?)
        .tooltip(tray_tooltip(0))
        .menu(&menu)
        // 左鍵切換視窗、右鍵開選單
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            MENU_SHOW => reveal_main_window(app),
            // 唯一真正的退出路徑(關閉視窗只會縮到系統匣)
            MENU_QUIT => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_main_window(tray.app_handle());
            }
        });

    // macOS 選單列用模板圖,系統會依淺 / 深色選單列自動上色
    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);

    builder.build(app)?;
    Ok(())
}

/// 更新未讀數:系統匣提示「kefu · N 則未讀」、macOS Dock 角標、Windows 工作列紅點;
/// 未讀增加且主視窗不在前景時請求使用者注意。
#[tauri::command]
fn set_unread(app: AppHandle, state: State<'_, UnreadState>, count: u32) -> Result<(), String> {
    let previous = {
        let mut current = state
            .0
            .lock()
            .map_err(|_| "unread state poisoned".to_string())?;
        std::mem::replace(&mut *current, count)
    };

    let window = app.get_webview_window(MAIN_WINDOW);
    apply_unread(&app, window.as_ref(), count);

    if count > previous {
        if let Some(window) = window.as_ref() {
            if !window.is_focused().unwrap_or(false) {
                let _ = window.request_user_attention(Some(UserAttentionType::Informational));
            }
        }
    }
    Ok(())
}

/// 把主視窗叫到前景(例如使用者點了系統通知)
#[tauri::command]
fn show_main_window(app: AppHandle) {
    reveal_main_window(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // single-instance 必須第一個註冊:第二個實例會把 argv 交給這裡後立即結束。
    // 開了 "deep-link" feature,外掛會先把 argv 中的 kefu:// 網址轉交 deep-link
    // (更新 getCurrent() 並發出 deep-link://new-url 事件,前端 onOpenUrl 收得到),再呼叫這個回呼。
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
        // 開機自動啟動又撞到已在執行的實例時,不要把視窗彈出來
        if argv.iter().any(|arg| arg == AUTOSTART_ARG) {
            return;
        }
        reveal_main_window(app);
    }));

    let builder = builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init());

    #[cfg(desktop)]
    let builder = builder
        // 記住視窗大小 / 位置,但不記「是否可見」:否則縮在系統匣時結束,下次啟動會看不到視窗
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !tauri_plugin_window_state::StateFlags::VISIBLE,
                )
                .build(),
        )
        // 開機自動啟動:預設關閉,由前端設定頁呼叫 enable() 才會寫入 LaunchAgent / 登錄檔
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ));

    builder
        .manage(UnreadState::default())
        .setup(|app| {
            // 開發版(Windows)與 Linux 在執行期註冊 kefu://;正式安裝檔由 MSI / NSIS 寫入登錄檔
            #[cfg(any(target_os = "linux", all(debug_assertions, windows)))]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                if let Err(err) = app.deep_link().register_all() {
                    eprintln!("[kefu] 註冊 kefu:// 失敗:{err}");
                }
            }

            #[cfg(desktop)]
            build_tray(app.handle())?;

            // 視窗在設定檔裡預設隱藏(避免 window-state 還原尺寸前閃一下);
            // 一般啟動就顯示,開機自動啟動則只常駐系統匣。
            let launched_by_autostart = std::env::args().any(|arg| arg == AUTOSTART_ARG);
            if !launched_by_autostart {
                reveal_main_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // 關閉主視窗 = 縮到系統匣(真正退出走系統匣選單「結束」或 macOS ⌘Q)
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == MAIN_WINDOW {
                    api.prevent_close();
                    // macOS 全螢幕時直接 hide 會留下一個黑色空白桌面,改成縮到 Dock
                    #[cfg(target_os = "macos")]
                    if window.is_fullscreen().unwrap_or(false) {
                        let _ = window.minimize();
                        return;
                    }
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![set_unread, show_main_window])
        .build(tauri::generate_context!())
        .expect("error while building kefu desktop app")
        .run(|_app, _event| {
            #[cfg(target_os = "macos")]
            match _event {
                // 點 Dock 圖示:視窗藏在系統匣時把它叫回來
                RunEvent::Reopen { .. } => reveal_main_window(_app),
                // 透過 kefu:// 開啟(deep-link 外掛已轉成 deep-link://new-url 事件),順便叫出視窗
                RunEvent::Opened { .. } => reveal_main_window(_app),
                _ => {}
            }
        });
}

#[cfg(test)]
mod tests {
    use super::tray_tooltip;

    #[test]
    fn tooltip_shows_unread_count() {
        assert_eq!(tray_tooltip(0), "kefu");
        assert_eq!(tray_tooltip(3), "kefu · 3 則未讀");
    }
}

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

/// 計算縮放後的主視窗尺寸(實體像素);已能完整放進螢幕可用區域時回 None(維持原樣)。
/// 超出時縮到可用區域的 90%,保留邊距。
fn fitted_size(outer: (u32, u32), area: (u32, u32)) -> Option<(u32, u32)> {
    let (ow, oh) = outer;
    let (aw, ah) = area;
    if aw == 0 || ah == 0 || (ow <= aw && oh <= ah) {
        return None;
    }
    Some((ow.min(aw * 9 / 10), oh.min(ah * 9 / 10)))
}

/// 視窗外框 `size` 在螢幕可用區域內置中時的左上角座標(實體像素)。
fn centered_origin(area_pos: (i32, i32), area: (u32, u32), size: (u32, u32)) -> (i32, i32) {
    let dx = area.0.saturating_sub(size.0) / 2;
    let dy = area.1.saturating_sub(size.1) / 2;
    (area_pos.0 + dx as i32, area_pos.1 + dy as i32)
}

/// 小螢幕防溢出:主視窗(預設 1280×800,或 window-state 還原的尺寸)比所在螢幕的可用區域
/// (扣除工作列 / Dock / 選單列)大時縮小並置中。例如 1366×768 的 Windows 筆電扣掉工作列
/// 只剩約 728px 高,不縮的話視窗下緣會超出螢幕。須在 window-state 還原之後、視窗顯示前呼叫
/// (見 place_and_reveal_main_window)。
#[cfg(desktop)]
fn fit_main_window_to_screen(app: &AppHandle) {
    let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
        return;
    };
    // 還原成最大化 / 全螢幕時由系統放進可用區域;這時 set_size / set_position 會把最大化取消
    if window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
        return;
    }
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let (Some(monitor), Ok(outer), Ok(inner)) = (monitor, window.outer_size(), window.inner_size()) else {
        return;
    };
    let area = monitor.work_area();
    let area_size = (area.size.width, area.size.height);
    if let Some((width, height)) = fitted_size((outer.width, outer.height), area_size) {
        // set_size 設的是內容區(inner):扣掉標題列 / 邊框,讓外框正好是 (width, height)
        let decor_w = outer.width.saturating_sub(inner.width);
        let decor_h = outer.height.saturating_sub(inner.height);
        let _ = window.set_size(tauri::PhysicalSize::new(
            width.saturating_sub(decor_w),
            height.saturating_sub(decor_h),
        ));
        // 自行計算置中座標,不用 center():macOS 的 set_size 是非同步的,緊接著 center()
        // 會拿舊尺寸計算(實測 1280 寬的視窗在 1024 寬螢幕上左緣落在 -128)
        let (x, y) = centered_origin((area.position.x, area.position.y), area_size, (width, height));
        let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

/// 主視窗上一次 Resized 時是否為最大化 / 全螢幕,用來偵測「從最大化還原」。
#[cfg(desktop)]
static MAIN_WINDOW_WAS_MAXIMIZED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// 從最大化 / 全螢幕還原時再縮一次:啟動時最大化的視窗不縮(見 fit_main_window_to_screen),
/// 但 window-state 存的一般尺寸可能是在大螢幕上存的,還原後會比這台螢幕大。
#[cfg(desktop)]
fn refit_after_unmaximize(window: &tauri::Window) {
    use std::sync::atomic::Ordering;
    if window.label() != MAIN_WINDOW || window.is_minimized().unwrap_or(false) {
        return;
    }
    let big = window.is_maximized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false);
    if MAIN_WINDOW_WAS_MAXIMIZED.swap(big, Ordering::Relaxed) && !big {
        fit_main_window_to_screen(window.app_handle());
    }
}

/// 啟動時:先讓主視窗放得進螢幕,再(非開機自動啟動時)顯示。
/// macOS 的 set_size / set_position(包括 window-state 在建立視窗時的還原)是排進 GCD 主佇列
/// 非同步執行的,setup 當下讀到的還是設定檔的預設尺寸:還原的過大尺寸會漏縮,小螢幕上則會用
/// 預設尺寸誤判而蓋掉使用者存的尺寸與位置。所以 macOS 上把縮放排在同一個主佇列(先進先出)、
/// 還原之後執行,顯示再排在縮放之後,避免先以舊位置顯示再跳動。
#[cfg(desktop)]
fn place_and_reveal_main_window(app: AppHandle, reveal: bool) {
    #[cfg(target_os = "macos")]
    {
        use dispatch2::DispatchQueue;
        DispatchQueue::main().exec_async(move || {
            fit_main_window_to_screen(&app);
            if reveal {
                DispatchQueue::main().exec_async(move || reveal_main_window(&app));
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        fit_main_window_to_screen(&app);
        if reveal {
            reveal_main_window(&app);
        }
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

            // 視窗在設定檔裡預設隱藏(避免 window-state 還原尺寸前閃一下);先確保放得進目前螢幕
            // (小筆電不超出畫面),一般啟動就顯示,開機自動啟動則只常駐系統匣。
            let launched_by_autostart = std::env::args().any(|arg| arg == AUTOSTART_ARG);
            #[cfg(desktop)]
            place_and_reveal_main_window(app.handle().clone(), !launched_by_autostart);
            #[cfg(not(desktop))]
            if !launched_by_autostart {
                reveal_main_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(desktop)]
            if let WindowEvent::Resized(_) = event {
                refit_after_unmaximize(window);
            }
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
    use super::{centered_origin, fitted_size, tray_tooltip};

    #[test]
    fn tooltip_shows_unread_count() {
        assert_eq!(tray_tooltip(0), "kefu");
        assert_eq!(tray_tooltip(3), "kefu · 3 則未讀");
    }

    #[test]
    fn window_kept_when_it_fits() {
        assert_eq!(fitted_size((1280, 800), (1920, 1040)), None);
        assert_eq!(fitted_size((1280, 800), (1280, 800)), None);
    }

    #[test]
    fn window_shrunk_on_small_screens() {
        // 1366×768 筆電扣掉工作列約 1366×728
        assert_eq!(fitted_size((1280, 800), (1366, 728)), Some((1229, 655)));
        assert_eq!(fitted_size((1280, 800), (1024, 700)), Some((921, 630)));
    }

    #[test]
    fn unknown_work_area_is_ignored() {
        assert_eq!(fitted_size((1280, 800), (0, 0)), None);
    }

    #[test]
    fn window_centered_in_work_area() {
        // macOS:選單列下方 25px 起算的可用區域
        assert_eq!(centered_origin((0, 25), (1024, 743), (921, 668)), (51, 62));
        // 副螢幕在主螢幕右側(可用區域原點非 0)
        assert_eq!(centered_origin((1920, 0), (1366, 728), (1229, 655)), (1988, 36));
        // 視窗比可用區域大時貼齊原點,不出現負座標
        assert_eq!(centered_origin((0, 0), (800, 600), (1280, 800)), (0, 0));
    }
}

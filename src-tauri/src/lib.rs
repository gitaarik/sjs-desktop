use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, State,
};
use tauri_plugin_updater::UpdaterExt;

/// App state shared between commands and the tray
struct AppState {
    status: Mutex<String>,
    sidecar_running: Mutex<bool>,
    has_config: Mutex<bool>,
    debug_chrome_open: Mutex<bool>,
    status_item: MenuItem<tauri::Wry>,
    connect_item: MenuItem<tauri::Wry>,
    chrome_item: MenuItem<tauri::Wry>,
    icon_active: Image<'static>,
    icon_inactive: Image<'static>,
    icon_reconnecting: Image<'static>,
}

/// Message from the sidecar (stdout JSON lines)
#[derive(Debug, Deserialize, Clone)]
#[serde(tag = "type")]
enum SidecarMessage {
    #[serde(rename = "status")]
    Status { status: String },
    #[serde(rename = "log")]
    Log { message: String },
    #[serde(rename = "intervention")]
    Intervention {
        #[serde(rename = "interventionType")]
        intervention_type: String,
    },
    #[serde(rename = "chromeReady")]
    ChromeReady { pid: Option<u32> },
    #[serde(rename = "chromeDownloadProgress")]
    ChromeDownloadProgress { percent: f64, status: String },
    #[serde(rename = "error")]
    Error { message: String },
}

/// Status payload sent to the frontend
#[derive(Debug, Serialize, Clone)]
struct StatusPayload {
    status: String,
}

/// Log payload sent to the frontend
#[derive(Debug, Serialize, Clone)]
struct LogPayload {
    message: String,
}

/// Intervention payload sent to the frontend
#[derive(Debug, Serialize, Clone)]
struct InterventionPayload {
    intervention_type: String,
}

/// Chrome download progress payload
#[derive(Debug, Serialize, Clone)]
struct ProgressPayload {
    percent: f64,
    status: String,
}

/// Get the current connection status
#[tauri::command]
fn get_status(state: State<AppState>) -> String {
    state.status.lock().unwrap().clone()
}

/// Check if sidecar is running
#[tauri::command]
fn is_sidecar_running(state: State<AppState>) -> bool {
    *state.sidecar_running.lock().unwrap()
}

/// Update the tray menu to reflect current connection state
#[tauri::command]
fn update_tray_state(
    app: AppHandle,
    state: State<AppState>,
    status: String,
    has_config: bool,
    has_chrome: bool,
    debug_chrome_open: bool,
) {
    *state.status.lock().unwrap() = status.clone();
    *state.has_config.lock().unwrap() = has_config;
    *state.debug_chrome_open.lock().unwrap() = debug_chrome_open;

    let status_text = match status.as_str() {
        "connected" => "Status: Connected",
        "scraping" => "Status: Scraping",
        "connecting" => "Status: Connecting...",
        "authenticating" => "Status: Authenticating...",
        "reconnecting" => "Status: Reconnecting...",
        _ => "Status: Disconnected",
    };
    let _ = state.status_item.set_text(status_text);

    let is_active = matches!(
        status.as_str(),
        "connected" | "scraping" | "connecting" | "authenticating" | "reconnecting"
    );
    if is_active {
        let _ = state.connect_item.set_text("Disconnect");
        let _ = state.connect_item.set_enabled(true);
    } else {
        let _ = state.connect_item.set_text("Connect");
        let _ = state.connect_item.set_enabled(has_config);
    }

    // Chrome menu item: enabled only when chrome is available and scraper is idle
    let chrome_enabled = has_chrome && !is_active;
    let chrome_text = if debug_chrome_open {
        "Close Browser"
    } else {
        "Open Browser"
    };
    let _ = state.chrome_item.set_text(chrome_text);
    let _ = state.chrome_item.set_enabled(chrome_enabled);

    // Swap tray icon based on connection state
    if let Some(tray) = app.tray_by_id("main-tray") {
        let icon = match status.as_str() {
            "connected" | "scraping" => &state.icon_active,
            "connecting" | "authenticating" | "reconnecting" => &state.icon_reconnecting,
            _ => &state.icon_inactive,
        };
        let _ = tray.set_icon(Some(icon.clone()));
    }

    update_tray_tooltip(&app, &status);
}

/// Update info returned to the frontend
#[derive(Debug, Serialize, Clone)]
struct UpdateInfo {
    version: String,
    body: Option<String>,
}

/// Check for updates using the specified channel endpoint
#[tauri::command]
async fn check_for_update(app: AppHandle, channel: String) -> Result<Option<UpdateInfo>, String> {
    let endpoint: url::Url = match channel.as_str() {
        "beta" => "https://github.com/gitaarik/sjs-desktop/releases/download/beta-latest/latest.json",
        _ => "https://github.com/gitaarik/sjs-desktop/releases/latest/download/latest.json",
    }
    .parse()
    .map_err(|e| format!("{e}"))?;

    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| format!("{e}"))?
        .build()
        .map_err(|e| format!("{e}"))?;

    match updater.check().await {
        Ok(Some(update)) => Ok(Some(UpdateInfo {
            version: update.version.clone(),
            body: update.body.clone(),
        })),
        Ok(None) => Ok(None),
        Err(e) => Err(format!("{e}")),
    }
}

/// Download and install an update from the specified channel
#[tauri::command]
async fn download_and_install_update(app: AppHandle, channel: String) -> Result<(), String> {
    let endpoint: url::Url = match channel.as_str() {
        "beta" => "https://github.com/gitaarik/sjs-desktop/releases/download/beta-latest/latest.json",
        _ => "https://github.com/gitaarik/sjs-desktop/releases/latest/download/latest.json",
    }
    .parse()
    .map_err(|e| format!("{e}"))?;

    let updater = app
        .updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| format!("{e}"))?
        .build()
        .map_err(|e| format!("{e}"))?;

    let update = updater
        .check()
        .await
        .map_err(|e| format!("{e}"))?
        .ok_or_else(|| "No update available".to_string())?;

    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| format!("{e}"))?;

    Ok(())
}

/// Update the tray tooltip with current status
fn update_tray_tooltip(app: &AppHandle, status: &str) {
    let tooltip = match status {
        "connected" => "SJS - Connected",
        "scraping" => "SJS - Scraping...",
        "connecting" | "authenticating" => "SJS - Connecting...",
        "reconnecting" => "SJS - Reconnecting...",
        "disconnected" => "SJS - Disconnected",
        _ => "Smart Job Seeker",
    };
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_tooltip(Some(tooltip));
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            get_status,
            is_sidecar_running,
            update_tray_state,
            check_for_update,
            download_and_install_update
        ])
        .setup(|app| {
            // Build tray menu
            let show_i =
                MenuItem::with_id(app, "show", "Open Local Scraper", true, None::<&str>)?;
            let chrome_i =
                MenuItem::with_id(app, "chrome", "Open Browser", false, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let status_i =
                MenuItem::with_id(app, "status", "Status: Disconnected", false, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let connect_i =
                MenuItem::with_id(app, "connect", "Connect", false, None::<&str>)?;
            let sep3 = PredefinedMenuItem::separator(app)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show_i, &chrome_i, &sep1, &status_i, &sep2, &connect_i, &sep3, &quit_i],
            )?;

            // Build active + inactive (grayed-out) tray icons from the default icon
            let default_icon = app.default_window_icon().unwrap();
            let width = default_icon.width();
            let height = default_icon.height();
            let rgba = default_icon.rgba().to_vec();
            let icon_active = Image::new_owned(rgba.clone(), width, height);
            let icon_reconnecting = {
                let dimmed: Vec<u8> = rgba
                    .chunks(4)
                    .flat_map(|px| [px[0], px[1], px[2], (px[3] as u16 * 165 / 255) as u8])
                    .collect();
                Image::new_owned(dimmed, width, height)
            };
            let icon_inactive = {
                let dimmed: Vec<u8> = rgba
                    .chunks(4)
                    .flat_map(|px| [px[0], px[1], px[2], (px[3] as u16 * 100 / 255) as u8])
                    .collect();
                Image::new_owned(dimmed, width, height)
            };

            // Store state with menu item references for dynamic updates
            app.manage(AppState {
                status: Mutex::new("disconnected".to_string()),
                sidecar_running: Mutex::new(false),
                has_config: Mutex::new(false),
                debug_chrome_open: Mutex::new(false),
                status_item: status_i,
                connect_item: connect_i,
                chrome_item: chrome_i,
                icon_active: icon_active.clone(),
                icon_inactive: icon_inactive.clone(),
                icon_reconnecting: icon_reconnecting.clone(),
            });

            // Create tray icon (starts inactive/grayed-out)
            let _tray = TrayIconBuilder::with_id("main-tray")
                .icon(icon_inactive)
                .menu(&menu)
                .tooltip("Smart Job Seeker")
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "connect" => {
                        let state = app.state::<AppState>();
                        let current = state.status.lock().unwrap().clone();
                        if matches!(
                            current.as_str(),
                            "connected" | "scraping" | "connecting" | "authenticating" | "reconnecting"
                        ) {
                            let _ = app.emit("tray-stop", ());
                        } else {
                            let _ = app.emit("tray-start", ());
                        }
                    }
                    "chrome" => {
                        let state = app.state::<AppState>();
                        let open = *state.debug_chrome_open.lock().unwrap();
                        if open {
                            let _ = app.emit("tray-close-chrome", ());
                        } else {
                            let _ = app.emit("tray-open-chrome", ());
                        }
                    }
                    "quit" => {
                        let _ = app.emit("tray-stop", ());
                        std::process::exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            // Hide window on close instead of quitting (tray keeps running)
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = window_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // Only prevent exit when triggered by last window closing (code None).
                // Allow explicit exits (code Some) e.g. from Quit menu item.
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}

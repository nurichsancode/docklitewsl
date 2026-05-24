// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::sync::Mutex;
use serde::{Serialize, Deserialize};
use tauri::Emitter;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[derive(Serialize, Deserialize, Clone, Debug)]
struct WslDistro {
    name: String,
    state: String,
    version: String,
    is_default: bool,
}

// Overall WSL availability reported to the frontend so it can show a
// friendly screen when WSL is missing or has no distros installed.
#[derive(Serialize)]
struct WslStatus {
    available: bool,         // could the `wsl` CLI be launched at all?
    distros: Vec<WslDistro>,
    message: String,         // human-friendly note when something is off
}

#[derive(Serialize, Deserialize)]
struct WslConfig {
    selected_distro: String,
}

// Payload pushed to the frontend for each streamed log line
#[derive(Clone, Serialize)]
struct LogLine {
    id: String,
    line: String,
}

// Holds every active `docker logs -f` child process, keyed by container id.
// This lets several container log streams run at once (one per open tab).
struct LogStreamState {
    children: Mutex<HashMap<String, std::process::Child>>,
}

// Path to the persisted config. Stored under %APPDATA% so it stays writable
// even when the app is installed to a read-only location (e.g. Program Files).
fn get_config_path() -> std::path::PathBuf {
    let mut dir = std::env::var("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    dir.push("DockLite WSL");
    let _ = std::fs::create_dir_all(&dir);
    dir.push("docklite_wsl_config.json");
    dir
}

// 1. Get WSL Distributions List + overall WSL availability
#[tauri::command]
fn get_wsl_distros() -> Result<WslStatus, String> {
    let mut cmd = std::process::Command::new("wsl");
    cmd.args(["-l", "-v"]);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let output = match cmd.output() {
        Ok(o) => o,
        Err(_) => {
            // The `wsl` executable itself could not be launched
            return Ok(WslStatus {
                available: false,
                distros: Vec::new(),
                message: "WSL was not found on this computer. Install WSL 2, then reopen the app.".to_string(),
            });
        }
    };

    // WSL prints UTF-16 on Windows; strip null bytes to recover ASCII text
    let stdout_str = String::from_utf8_lossy(&output.stdout);
    let stderr_str = String::from_utf8_lossy(&output.stderr);
    let clean_out: String = stdout_str.chars().filter(|&c| c != '\0').collect();
    let clean_err: String = stderr_str.chars().filter(|&c| c != '\0').collect();

    let mut distros = Vec::new();
    for line in clean_out.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let mut is_default = false;
        let mut clean_line = trimmed;
        if let Some(rest) = trimmed.strip_prefix('*') {
            is_default = true;
            clean_line = rest.trim();
        }

        let parts: Vec<&str> = clean_line.split_whitespace().collect();
        // A genuine `wsl -l -v` row is "NAME  STATE  VERSION", and VERSION
        // is always "1" or "2". Requiring that rejects the header row and
        // any prose / error text WSL prints when it is not set up.
        if parts.len() >= 3 {
            let version = parts[parts.len() - 1];
            if version == "1" || version == "2" {
                let state = parts[parts.len() - 2].to_string();
                let name = parts[..parts.len() - 2].join(" ");
                distros.push(WslDistro {
                    name,
                    state,
                    version: version.to_string(),
                    is_default,
                });
            }
        }
    }

    if distros.is_empty() {
        // No valid distro rows: decide whether WSL itself is missing/unset-up
        // versus simply having no distro installed.
        let combined = format!("{} {}", clean_out, clean_err).to_lowercase();
        let looks_uninstalled = !output.status.success()
            || combined.contains("no installed distributions")
            || combined.contains("not installed")
            || combined.contains("aka.ms/wslstore")
            || combined.contains("wsl/install");
        let message = if looks_uninstalled {
            "WSL is not set up, or no Linux distro has been installed yet.".to_string()
        } else {
            "No WSL distros were detected.".to_string()
        };
        return Ok(WslStatus {
            available: true,
            distros,
            message,
        });
    }

    Ok(WslStatus {
        available: true,
        distros,
        message: String::new(),
    })
}

// 2. Get Currently Selected Distro from config
#[tauri::command]
fn get_selected_distro() -> Result<Option<String>, String> {
    let config_path = get_config_path();
    let path = Path::new(&config_path);
    if path.exists() {
        let mut file = File::open(path).map_err(|e| e.to_string())?;
        let mut contents = String::new();
        file.read_to_string(&mut contents).map_err(|e| e.to_string())?;
        
        let config: WslConfig = serde_json::from_str(&contents).unwrap_or(WslConfig {
            selected_distro: "".to_string(),
        });
        
        if config.selected_distro.is_empty() {
            Ok(None)
        } else {
            Ok(Some(config.selected_distro))
        }
    } else {
        Ok(None)
    }
}

// 3. Save Selected Distro to config
#[tauri::command]
fn select_wsl_distro(distro: String) -> Result<(), String> {
    let config_path = get_config_path();
    let config = WslConfig {
        selected_distro: distro,
    };
    
    let json_str = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    let mut file = File::create(config_path).map_err(|e| e.to_string())?;
    file.write_all(json_str.as_bytes()).map_err(|e| e.to_string())?;
    
    Ok(())
}

// Helper to run raw docker command on target WSL distro
fn run_docker_cmd(distro: &str, args: Vec<&str>) -> Result<String, String> {
    let mut wsl_args = vec!["-d", distro, "docker"];
    wsl_args.extend(args);
    
    let mut cmd = std::process::Command::new("wsl");
    cmd.args(&wsl_args);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output()
        .map_err(|e| format!("Failed to reach Docker in WSL: {}", e))?;
        
    if !output.status.success() {
        let stderr_str = String::from_utf8_lossy(&output.stderr);
        return Err(stderr_str.trim().to_string());
    }
    
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

// 4. Get Containers List
#[tauri::command]
fn get_containers(distro: String) -> Result<Vec<serde_json::Value>, String> {
    let stdout = run_docker_cmd(&distro, vec!["ps", "-a", "--format", "{{json .}}"])?;
    
    let mut containers = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                containers.push(v);
            }
        }
    }
    
    Ok(containers)
}

// 5. Get Images List
#[tauri::command]
fn get_images(distro: String) -> Result<Vec<serde_json::Value>, String> {
    let stdout = run_docker_cmd(&distro, vec!["images", "--format", "{{json .}}"])?;
    
    let mut images = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                images.push(v);
            }
        }
    }
    
    Ok(images)
}

// 6. Get Resource Stats
#[tauri::command]
fn get_containers_stats(distro: String) -> Result<Vec<serde_json::Value>, String> {
    let stdout = run_docker_cmd(&distro, vec!["stats", "--no-stream", "--format", "{{json .}}"])?;
    
    let mut stats = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if !trimmed.is_empty() {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(trimmed) {
                stats.push(v);
            }
        }
    }
    
    Ok(stats)
}

// 7. Start streaming logs for one container (long-lived `docker logs -f`).
// Each line is pushed to the frontend via the "log-line" Tauri event,
// tagged with the container id so the frontend can route it to the right tab.
#[tauri::command]
fn start_log_stream(
    app: tauri::AppHandle,
    state: tauri::State<'_, LogStreamState>,
    distro: String,
    id: String,
    tail: i32,
) -> Result<(), String> {
    // If a stream for this container is already running, stop it first
    let existing = state.children.lock().unwrap().remove(&id);
    if let Some(mut old) = existing {
        let _ = old.kill();
        let _ = old.wait();
    }

    let tail_str = tail.to_string();
    let mut cmd = std::process::Command::new("wsl");
    cmd.args(["-d", &distro, "docker", "logs", "-f", "--tail", &tail_str, &id]);
    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn()
        .map_err(|e| format!("Failed to start log stream: {}", e))?;

    let stdout = child.stdout.take().ok_or("Could not read stdout")?;
    let stderr = child.stderr.take().ok_or("Could not read stderr")?;

    // Reader thread: container stdout
    let app_out = app.clone();
    let id_out = id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            match line {
                Ok(text) => {
                    let _ = app_out.emit("log-line", LogLine { id: id_out.clone(), line: text });
                }
                Err(_) => break,
            }
        }
    });

    // Reader thread: container stderr (docker logs preserves both streams)
    let app_err = app.clone();
    let id_err = id.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(stderr).lines() {
            match line {
                Ok(text) => {
                    let _ = app_err.emit("log-line", LogLine { id: id_err.clone(), line: text });
                }
                Err(_) => break,
            }
        }
    });

    state.children.lock().unwrap().insert(id, child);
    Ok(())
}

// 7b. Stop the log stream for one container (when its tab is closed)
#[tauri::command]
fn stop_log_stream(state: tauri::State<'_, LogStreamState>, id: String) -> Result<(), String> {
    let existing = state.children.lock().unwrap().remove(&id);
    if let Some(mut child) = existing {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

// 7c. Stop every active log stream (e.g. when switching WSL distro)
#[tauri::command]
fn stop_all_log_streams(state: tauri::State<'_, LogStreamState>) -> Result<(), String> {
    let mut map = state.children.lock().unwrap();
    for (_, mut child) in map.drain() {
        let _ = child.kill();
        let _ = child.wait();
    }
    Ok(())
}

// 8. Run Container Action (start/stop/restart/rm)
#[tauri::command]
fn run_container_action(distro: String, id: String, action: String) -> Result<String, String> {
    let mut args = Vec::new();
    match action.as_str() {
        "start" => args.push("start"),
        "stop" => args.push("stop"),
        "restart" => args.push("restart"),
        "delete" => {
            args.push("rm");
            args.push("-f");
        },
        _ => return Err("Invalid action".to_string()),
    }
    
    args.push(&id);
    run_docker_cmd(&distro, args)
}

// 9. Deploy New Container
#[tauri::command]
fn deploy_container(
    distro: String,
    image: String,
    name: String,
    ports: String,
    envs: Vec<String>,
) -> Result<String, String> {
    let mut args = vec!["run", "-d"];
    
    let trimmed_name = name.trim();
    if !trimmed_name.is_empty() {
        args.push("--name");
        args.push(trimmed_name);
    }
    
    let trimmed_ports = ports.trim();
    if !trimmed_ports.is_empty() {
        args.push("-p");
        args.push(trimmed_ports);
    }
    
    let mut env_pairs = Vec::new();
    for env in &envs {
        let trimmed_env = env.trim();
        if !trimmed_env.is_empty() {
            env_pairs.push(trimmed_env);
        }
    }
    
    for pair in &env_pairs {
        args.push("-e");
        args.push(pair);
    }
    
    args.push(&image);
    
    run_docker_cmd(&distro, args)
}

// 10. Remove Image
#[tauri::command]
fn remove_image(distro: String, id: String) -> Result<String, String> {
    run_docker_cmd(&distro, vec!["rmi", "-f", &id])
}

// 11. Inspect a container (full `docker inspect` detail as JSON)
#[tauri::command]
fn inspect_container(distro: String, id: String) -> Result<serde_json::Value, String> {
    let stdout = run_docker_cmd(&distro, vec!["inspect", &id])?;
    let parsed: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|e| format!("Failed to parse inspect data: {}", e))?;

    // `docker inspect` returns a JSON array; we want the first element
    match parsed.as_array().and_then(|arr| arr.first()) {
        Some(first) => Ok(first.clone()),
        None => Err("Inspect data was empty".to_string()),
    }
}

// 12. List processes running inside a container (`docker top`)
#[tauri::command]
fn get_container_top(distro: String, id: String) -> Result<String, String> {
    run_docker_cmd(&distro, vec!["top", &id])
}

// 13. Run a one-shot command inside a container (`docker exec ... sh -c`).
// Returns combined stdout+stderr regardless of exit code, so the user can
// still see error output from a failed command.
#[tauri::command]
fn exec_in_container(distro: String, id: String, command: String) -> Result<String, String> {
    let mut cmd = std::process::Command::new("wsl");
    cmd.args(["-d", &distro, "docker", "exec", &id, "sh", "-c", &command]);
    #[cfg(target_os = "windows")]
    {
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output()
        .map_err(|e| format!("Failed to run exec: {}", e))?;

    let combined = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );

    Ok(combined)
}

// 14. Prune unused Docker data: stopped containers, unused networks,
// dangling images, and build cache. Uses `-f` to skip Docker's own prompt
// (the frontend already asks the user to confirm).
#[tauri::command]
fn prune_docker(distro: String) -> Result<String, String> {
    run_docker_cmd(&distro, vec!["system", "prune", "-f"])
}

fn main() {
    tauri::Builder::default()
        .manage(LogStreamState {
            children: Mutex::new(HashMap::new()),
        })
        .invoke_handler(tauri::generate_handler![
            get_wsl_distros,
            get_selected_distro,
            select_wsl_distro,
            get_containers,
            get_images,
            get_containers_stats,
            start_log_stream,
            stop_log_stream,
            stop_all_log_streams,
            run_container_action,
            deploy_container,
            remove_image,
            inspect_container,
            get_container_top,
            exec_in_container,
            prune_docker
        ])
        .run(tauri::generate_context!())
        .expect("failed to start the Tauri application");
}

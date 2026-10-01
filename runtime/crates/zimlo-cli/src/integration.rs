use std::{
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};

use serde_json::{Map, Value, json};
use tokio::{process::Command, time::timeout};

const EVENTS: [&str; 3] = ["SessionStart", "PreToolUse", "PermissionRequest"];

pub async fn statuses(executable: &Path) -> Vec<Value> {
    let codex = resolve_command("codex");
    let claude = resolve_command("claude");
    let codex_hooks = hook_ready("codex", executable);
    let claude_hooks = hook_ready("claude", executable);
    let codex_mcp = match codex.as_deref() {
        Some(command) => command_output(command, &["mcp", "get", "zimlo"])
            .await
            .is_some_and(|output| output.contains(executable.to_string_lossy().as_ref())),
        None => false,
    };
    let claude_mcp = claude_mcp_ready(executable);
    let plugin = plugin_status(executable).await;
    let plugin_owns_hooks = dirs::home_dir().is_some_and(|home| codex_plugin_owns_hooks(&home));
    vec![
        json!({
            "id": "codex_gui", "provider": "codex", "surface": "gui",
            "state": if plugin["installed"] == true { "ready" } else if codex.is_some() { "partial" } else { "unavailable" },
            "label": "Codex · GUI", "detail": plugin["detail"],
        }),
        if plugin_owns_hooks {
            json!({
                "id": "codex_cli", "provider": "codex", "surface": "cli",
                "state": if plugin["installed"] == true { "shared" } else if codex.is_some() { "partial" } else { "unavailable" },
                "label": "Codex · CLI", "detail": plugin["detail"],
            })
        } else {
            cli_status(
                "codex_cli",
                "codex",
                codex.is_some(),
                codex_hooks,
                codex_mcp,
            )
        },
        json!({
            "id": "claude_gui", "provider": "claude", "surface": "gui",
            "state": if claude_hooks && claude_mcp { "shared" } else if claude.is_some() { "partial" } else { "unavailable" },
            "label": "Claude Code · GUI",
            "detail": if claude_hooks && claude_mcp { "Claude App 与 CLI 共用接入，当前已启用。" } else if claude.is_some() { "已发现 Claude Code，但共享 Hooks 或 MCP 尚未配置。" } else { "尚未发现 Claude Code。" },
        }),
        cli_status(
            "claude_cli",
            "claude",
            claude.is_some(),
            claude_hooks,
            claude_mcp,
        ),
    ]
}

pub async fn install_cli(executable: &Path) -> Result<(), String> {
    install_selected_cli(executable, None).await
}

pub async fn install_selected_cli(
    executable: &Path,
    requested: Option<&str>,
) -> Result<(), String> {
    let providers = ["codex", "claude"]
        .into_iter()
        .filter(|provider| requested.is_none_or(|target| target == *provider))
        .filter_map(|provider| resolve_command(provider).map(|command| (provider, command)))
        .collect::<Vec<_>>();
    if providers.is_empty() {
        return Err("尚未发现 Codex 或 Claude Code。".into());
    }
    for (provider, command) in providers {
        if provider == "codex"
            && dirs::home_dir().is_some_and(|home| codex_plugin_owns_hooks(&home))
        {
            install_plugin(executable).await?;
            continue;
        }
        write_hook_config(provider, executable, false)?;
        let executable = executable.to_string_lossy().into_owned();
        if provider == "codex" {
            let _ = command_output(&command, &["mcp", "remove", "zimlo"]).await;
            require_command(
                &command,
                &[
                    "mcp",
                    "add",
                    "zimlo",
                    "--",
                    &executable,
                    "mcp",
                    "--provider",
                    "codex",
                ],
            )
            .await?;
        } else {
            let _ = command_output(&command, &["mcp", "remove", "zimlo", "-s", "user"]).await;
            require_command(
                &command,
                &[
                    "mcp",
                    "add",
                    "--scope",
                    "user",
                    "zimlo",
                    "--",
                    &executable,
                    "mcp",
                    "--provider",
                    "claude",
                ],
            )
            .await?;
        }
    }
    Ok(())
}

pub fn hooks_diff(executable: &Path) -> Result<Vec<Value>, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录。".to_owned())?;
    let plugin_owns_hooks = codex_plugin_owns_hooks(&home);
    let mut changes = ["codex", "claude"]
        .into_iter()
        .map(|provider| {
            let path = hook_path(provider)?;
            let before = read_object(&path)?;
            let after = desired_user_hooks(
                before.clone(),
                provider,
                executable,
                false,
                plugin_owns_hooks,
            );
            Ok(json!({ "path": path, "before": before, "after": after }))
        })
        .collect::<Result<Vec<_>, String>>()?;
    if plugin_owns_hooks {
        let path = home.join("plugins/zimlo/hooks/hooks.json");
        let before = read_object(&path)?;
        let after = json!({ "description": "Zimlo session binding and synchronous action bridge for Codex", "hooks": hook_groups("codex", executable) });
        changes.push(json!({ "path": path, "before": before, "after": after }));
    }
    Ok(changes)
}

pub async fn install_hooks(executable: &Path, uninstall: bool) -> Result<(), String> {
    let mut found = false;
    for provider in ["codex", "claude"] {
        if uninstall || resolve_command(provider).is_some() {
            found = true;
            if !uninstall
                && provider == "codex"
                && dirs::home_dir().is_some_and(|home| codex_plugin_owns_hooks(&home))
            {
                install_plugin(executable).await?;
            } else {
                write_hook_config(provider, executable, uninstall)?;
            }
        }
    }
    if !found && !uninstall {
        return Err("尚未发现 Codex 或 Claude Code。".into());
    }
    Ok(())
}

pub async fn plugin_status(executable: &Path) -> Value {
    let Some(home) = dirs::home_dir() else {
        return json!({ "installed": false, "detail": "无法定位用户目录。", "pluginPath": null, "deepLink": null });
    };
    let plugin = home.join("plugins/zimlo");
    let manifest = plugin.join(".codex-plugin/plugin.json");
    let installed_manifest = Value::Object(read_object(&manifest).unwrap_or_default());
    let bundled_manifest = Value::Object(
        bundled_plugin_root(executable)
            .and_then(|root| read_object(&root.join(".codex-plugin/plugin.json")).ok())
            .unwrap_or_default(),
    );
    let mcp = Value::Object(read_object(&plugin.join(".mcp.json")).unwrap_or_default());
    let command = mcp["mcpServers"]["zimlo"]["command"].as_str();
    let args = mcp["mcpServers"]["zimlo"]["args"].as_array();
    let hooks = Value::Object(read_object(&plugin.join("hooks/hooks.json")).unwrap_or_default());
    let commands_current = command == Some(executable.to_string_lossy().as_ref())
        && args.is_some_and(|args| {
            args.iter().filter_map(Value::as_str).collect::<Vec<_>>()
                == ["mcp", "--provider", "codex"]
        })
        && hooks["hooks"] == hook_groups("codex", executable);
    let legacy_hooks = read_object(&home.join(".codex/hooks.json"));
    let duplicate_hooks = legacy_hooks
        .as_ref()
        .is_ok_and(|before| before != &merged_hooks(before.clone(), "codex", executable, true));
    let marketplace = Value::Object(
        read_object(&home.join(".agents/plugins/marketplace.json")).unwrap_or_default(),
    );
    let marketplace_present = marketplace["plugins"].as_array().is_some_and(|plugins| {
        plugins.iter().any(|item| {
            item["name"] == "zimlo"
                && item["source"]["source"] == "local"
                && item["source"]["path"] == "./plugins/zimlo"
        })
    });
    let version_current = installed_manifest["version"].as_str().is_some()
        && installed_manifest["version"] == bundled_manifest["version"];
    let codex = resolve_command("codex");
    let runtime = match codex.as_deref() {
        Some(codex) => command_json(codex, &["plugin", "list", "--json"])
            .await
            .map(parse_codex_runtime)
            .unwrap_or((false, false, None)),
        None => (false, false, None),
    };
    let runtime_version_current = bundled_manifest["version"]
        .as_str()
        .is_some_and(|version| runtime.2.as_deref() == Some(version));
    let plugin_present = manifest.is_file() && installed_manifest["name"] == "zimlo";
    let source_ready = plugin_present
        && marketplace_present
        && commands_current
        && version_current
        && legacy_hooks.is_ok()
        && !duplicate_hooks;
    let installed = source_ready && runtime.0 && runtime.1 && runtime_version_current;
    let detail = if installed {
        "Codex 桌面版与 CLI 共用 Zimlo 插件；请审核 hooks 并新建任务。"
    } else if !plugin_present {
        "未安装"
    } else if !marketplace_present {
        "插件文件存在，但 Personal marketplace 未注册"
    } else if duplicate_hooks || legacy_hooks.is_err() {
        "发现重复或无效的 Zimlo 用户级 hook，请修复配置并重新安装插件。"
    } else if !commands_current {
        "插件命令指向旧版 Runtime，需要重新安装"
    } else if !version_current {
        "插件内容版本已过期，请重新安装并新建 Codex 任务"
    } else if codex.is_none() {
        "尚未发现 Codex App 或 CLI。"
    } else if !runtime.0 {
        "插件源已准备，但尚未在 Codex App 中安装。"
    } else if !runtime.1 {
        "Codex App 中的 Zimlo 插件当前未启用。"
    } else {
        "Codex App 仍在使用旧版 Zimlo 插件，请重新安装。"
    };
    json!({
        "installed": installed,
        "runtimeInstalled": runtime.0,
        "runtimeEnabled": runtime.1,
        "pluginPresent": plugin_present,
        "marketplacePresent": marketplace_present,
        "commandsCurrent": commands_current,
        "versionCurrent": version_current,
        "detail": detail,
        "pluginPath": plugin,
        "deepLink": "codex://plugins/personal/zimlo",
    })
}

pub async fn install_plugin(executable: &Path) -> Result<Value, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录。".to_owned())?;
    // Validate before activation; migrate only after the plugin is active.
    read_object(&home.join(".codex/hooks.json"))?;
    let source = bundled_plugin_root(executable)
        .ok_or_else(|| "Runtime 包中缺少 Codex 插件资源。".to_owned())?;
    let plugins_root = home.join("plugins");
    let destination = plugins_root.join("zimlo");
    let temporary = plugins_root.join(format!(".zimlo-install-{}", std::process::id()));
    let previous = plugins_root.join(format!(".zimlo-previous-{}", std::process::id()));
    fs::create_dir_all(&plugins_root).map_err(display)?;
    if temporary.exists() {
        fs::remove_dir_all(&temporary).map_err(display)?;
    }
    copy_tree(&source, &temporary).map_err(display)?;
    write_json(
        &temporary.join(".mcp.json"),
        &json!({ "mcpServers": { "zimlo": { "command": executable, "args": ["mcp", "--provider", "codex"] } } }),
    )?;
    write_json(
        &temporary.join("hooks/hooks.json"),
        &json!({ "description": "Zimlo session binding and synchronous action bridge for Codex", "hooks": hook_groups("codex", executable) }),
    )?;
    if previous.exists() {
        fs::remove_dir_all(&previous).map_err(display)?;
    }
    let moved_previous = if destination.exists() {
        fs::rename(&destination, &previous).map_err(display)?;
        true
    } else {
        false
    };
    if let Err(error) = fs::rename(&temporary, &destination) {
        if moved_previous {
            let _ = fs::rename(&previous, &destination);
        }
        return Err(display(error));
    }

    let marketplace_path = home.join(".agents/plugins/marketplace.json");
    let previous_marketplace = fs::read(&marketplace_path).ok();
    let mut marketplace = read_object(&marketplace_path)?;
    if marketplace.is_empty() {
        marketplace.insert("name".into(), Value::String("personal".into()));
        marketplace.insert("interface".into(), json!({ "displayName": "Personal" }));
    }
    let entry = json!({
        "name": "zimlo",
        "source": { "source": "local", "path": "./plugins/zimlo" },
        "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
        "category": "Developer Tools",
    });
    let mut plugins = marketplace
        .remove("plugins")
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    if plugins.iter().any(|item| {
        item["name"] == "zimlo"
            && (item["source"]["source"] != "local" || item["source"]["path"] != "./plugins/zimlo")
    }) {
        let _ = fs::remove_dir_all(&destination);
        if moved_previous {
            let _ = fs::rename(&previous, &destination);
        }
        return Err("Personal marketplace 已有另一个名为 zimlo 的来源，未自动覆盖。".into());
    }
    plugins.retain(|item| item["name"] != "zimlo");
    plugins.push(entry);
    marketplace.insert("plugins".into(), Value::Array(plugins));
    if let Err(error) = write_json(&marketplace_path, &Value::Object(marketplace)) {
        let _ = fs::remove_dir_all(&destination);
        if moved_previous {
            let _ = fs::rename(&previous, &destination);
        }
        return Err(error);
    }
    if let Some(codex) = resolve_command("codex") {
        let _ = command_output(&codex, &["plugin", "remove", "zimlo@personal", "--json"]).await;
        if let Err(error) =
            require_command(&codex, &["plugin", "add", "zimlo@personal", "--json"]).await
        {
            let _ = fs::remove_dir_all(&destination);
            if moved_previous {
                let _ = fs::rename(&previous, &destination);
            }
            if let Some(contents) = previous_marketplace {
                let _ = fs::write(&marketplace_path, contents);
                let _ = private(&marketplace_path);
            } else {
                let _ = fs::remove_file(&marketplace_path);
            }
            return Err(format!("Codex 插件激活失败，已回滚：{error}"));
        }
    }
    if moved_previous {
        fs::remove_dir_all(&previous).map_err(display)?;
    }
    migrate_codex_hooks(&home, executable)?;
    Ok(plugin_status(executable).await)
}

pub async fn uninstall_plugin(executable: &Path) -> Result<Value, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录。".to_owned())?;
    if let Some(codex) = resolve_command("codex") {
        let _ = command_output(&codex, &["plugin", "remove", "zimlo@personal", "--json"]).await;
    }
    let marketplace_path = home.join(".agents/plugins/marketplace.json");
    let mut marketplace = read_object(&marketplace_path)?;
    if let Some(plugins) = marketplace.get_mut("plugins").and_then(Value::as_array_mut) {
        plugins.retain(|item| {
            !(item["name"] == "zimlo"
                && item["source"]["source"] == "local"
                && item["source"]["path"] == "./plugins/zimlo")
        });
        write_json(&marketplace_path, &Value::Object(marketplace))?;
    }
    for plugin in [
        home.join("plugins/zimlo"),
        home.join(".agents/plugins/plugins/zimlo"),
    ] {
        if read_object(&plugin.join(".codex-plugin/plugin.json"))
            .ok()
            .is_some_and(|manifest| manifest["name"] == "zimlo")
        {
            fs::remove_dir_all(plugin).map_err(display)?;
        }
    }
    let mut status = plugin_status(executable).await;
    status["detail"] =
        "Zimlo Personal 插件源已移除；若 GUI 中仍显示已安装，请在 Plugins 页面卸载".into();
    Ok(status)
}

fn parse_codex_runtime(value: Value) -> (bool, bool, Option<String>) {
    let plugin = value["installed"].as_array().and_then(|items| {
        items.iter().find(|item| {
            item["pluginId"] == "zimlo@personal"
                || item["name"] == "zimlo" && item["marketplaceName"] == "personal"
        })
    });
    match plugin {
        Some(plugin) => (
            plugin["installed"] == true,
            plugin["enabled"] == true,
            plugin["version"].as_str().map(str::to_owned),
        ),
        None => (false, false, None),
    }
}

fn cli_status(id: &str, provider: &str, available: bool, hooks: bool, mcp: bool) -> Value {
    let label = if provider == "codex" {
        "Codex · CLI"
    } else {
        "Claude Code · CLI"
    };
    let state = if !available {
        "unavailable"
    } else if hooks && mcp {
        "ready"
    } else if hooks || mcp {
        "partial"
    } else {
        "unavailable"
    };
    let detail = if !available {
        format!(
            "尚未发现{}。",
            if provider == "codex" {
                " Codex CLI"
            } else {
                " Claude Code"
            }
        )
    } else if hooks && mcp {
        "Hooks 与 MCP 已配置；新 CLI 任务会自动接入 Zimlo。".into()
    } else {
        format!(
            "还需{}。",
            if hooks {
                "更新 MCP"
            } else if mcp {
                "更新 Hooks"
            } else {
                "配置 Hooks 与 MCP"
            }
        )
    };
    json!({ "id": id, "provider": provider, "surface": "cli", "state": state, "label": label, "detail": detail })
}

fn hook_path(provider: &str) -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "无法定位用户目录。".to_owned())?;
    Ok(if provider == "codex" {
        home.join(".codex/hooks.json")
    } else {
        home.join(".claude/settings.json")
    })
}

fn hook_ready(provider: &str, executable: &Path) -> bool {
    if provider == "codex"
        && let Some(home) = dirs::home_dir()
        && codex_plugin_owns_hooks(&home)
    {
        let config = read_object(&home.join("plugins/zimlo/hooks/hooks.json"));
        let legacy = read_object(&home.join(".codex/hooks.json"));
        return config
            .is_ok_and(|config| config.get("hooks") == Some(&hook_groups("codex", executable)))
            && legacy.is_ok_and(|config| {
                config == merged_hooks(config.clone(), "codex", executable, true)
            });
    }
    let Ok(path) = hook_path(provider) else {
        return false;
    };
    let Ok(config) = read_object(&path) else {
        return false;
    };
    hook_config_ready(&config, provider, executable)
}

fn hook_config_ready(config: &Map<String, Value>, provider: &str, executable: &Path) -> bool {
    let Some(hooks) = config.get("hooks").and_then(Value::as_object) else {
        return false;
    };
    EVENTS.iter().all(|event| {
        hooks
            .get(*event)
            .and_then(Value::as_array)
            .is_some_and(|groups| {
                groups.iter().any(|group| {
                    group["hooks"].as_array().is_some_and(|handlers| {
                        handlers.iter().any(|handler| {
                            handler["command"].as_str().is_some_and(|command| {
                                command.contains(executable.to_string_lossy().as_ref())
                                    && command.contains(&format!("hook --provider {provider}"))
                            })
                        })
                    })
                })
            })
    })
}

fn claude_mcp_ready(executable: &Path) -> bool {
    let Some(home) = dirs::home_dir() else {
        return false;
    };
    let Ok(value) = read_object(&home.join(".claude.json")) else {
        return false;
    };
    value
        .get("mcpServers")
        .and_then(Value::as_object)
        .and_then(|servers| servers.get("zimlo"))
        .and_then(Value::as_object)
        .and_then(|server| server.get("command"))
        .and_then(Value::as_str)
        == Some(executable.to_string_lossy().as_ref())
}

fn write_hook_config(provider: &str, executable: &Path, uninstall: bool) -> Result<bool, String> {
    let path = hook_path(provider)?;
    let before = read_object(&path)?;
    let plugin_owns_hooks = dirs::home_dir().is_some_and(|home| codex_plugin_owns_hooks(&home));
    let after = desired_user_hooks(
        before.clone(),
        provider,
        executable,
        uninstall,
        plugin_owns_hooks,
    );
    if before == after {
        return Ok(false);
    }
    write_json(&path, &Value::Object(after))?;
    Ok(true)
}

fn codex_plugin_owns_hooks(home: &Path) -> bool {
    let manifest = read_object(&home.join("plugins/zimlo/.codex-plugin/plugin.json"));
    manifest.is_ok_and(|value| value.get("name") == Some(&json!("zimlo")))
}

fn migrate_codex_hooks(home: &Path, executable: &Path) -> Result<bool, String> {
    let path = home.join(".codex/hooks.json");
    let before = read_object(&path)?;
    let after = merged_hooks(before.clone(), "codex", executable, true);
    if before == after {
        return Ok(false);
    }
    write_json(&path, &Value::Object(after))?;
    Ok(true)
}

fn desired_user_hooks(
    root: Map<String, Value>,
    provider: &str,
    executable: &Path,
    uninstall: bool,
    plugin_owns_hooks: bool,
) -> Map<String, Value> {
    merged_hooks(
        root,
        provider,
        executable,
        uninstall || (provider == "codex" && plugin_owns_hooks),
    )
}

fn merged_hooks(
    mut root: Map<String, Value>,
    provider: &str,
    executable: &Path,
    uninstall: bool,
) -> Map<String, Value> {
    let command = hook_command(executable, provider, "auto");
    if uninstall && !root.get("hooks").is_some_and(Value::is_object) {
        return root;
    }
    let hooks = root.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        *hooks = json!({});
    }
    let hooks = hooks.as_object_mut().expect("object");
    let mut empty_events = Vec::new();
    for (event, raw_groups) in hooks.iter_mut() {
        let Some(groups) = raw_groups.as_array_mut() else {
            continue;
        };
        let count = groups.len();
        groups.retain_mut(|group| {
            if let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut) {
                let count = handlers.len();
                handlers.retain(|handler| {
                    !handler["command"].as_str().is_some_and(|value| {
                        value.contains("zimlo")
                            && value.contains(&format!("hook --provider {provider}"))
                    })
                });
                count == handlers.len() || !handlers.is_empty()
            } else {
                true
            }
        });
        if count > 0 && groups.is_empty() {
            empty_events.push(event.clone());
        }
    }
    for event in empty_events {
        hooks.remove(&event);
    }
    if !uninstall {
        for event in EVENTS {
            let groups = hooks.entry(event).or_insert_with(|| json!([]));
            if !groups.is_array() {
                *groups = json!([]);
            }
            groups
                .as_array_mut()
                .expect("array")
                .push(single_hook_group(event, provider, &command));
        }
    }
    root
}

fn hook_groups(provider: &str, executable: &Path) -> Value {
    let command = hook_command(executable, provider, "auto");
    Value::Object(
        EVENTS
            .into_iter()
            .map(|event| {
                (
                    event.into(),
                    Value::Array(vec![single_hook_group(event, provider, &command)]),
                )
            })
            .collect(),
    )
}

fn single_hook_group(event: &str, provider: &str, command: &str) -> Value {
    let mut handler = json!({
        "type": "command",
        "command": command,
        "timeout": if event == "SessionStart" { 5 } else { 480 },
    });
    if event == "PermissionRequest" {
        handler["statusMessage"] = json!("Waiting for Zimlo approval");
    }
    if event == "PreToolUse" {
        handler["statusMessage"] = json!("Waiting for Zimlo input");
    }
    if event == "SessionStart" {
        handler["statusMessage"] = json!("Binding Zimlo session");
    }
    json!({
        "matcher": if event == "SessionStart" { "startup|resume|clear" } else if event == "PreToolUse" { if provider == "codex" { "request_user_input" } else { "AskUserQuestion" } } else { "*" },
        "hooks": [handler],
    })
}

fn hook_command(executable: &Path, provider: &str, surface: &str) -> String {
    format!(
        "{} hook --provider {provider} --surface {surface}",
        shell_quote(executable.to_string_lossy().as_ref())
    )
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('!', "\\!").replace('\'', "'\"'\"'"))
}

fn bundled_plugin_root(executable: &Path) -> Option<PathBuf> {
    let prefix = executable.parent()?.parent()?;
    for bundled in [
        prefix.join("Resources/plugin/zimlo"),
        prefix.join("share/zimlo/plugin/zimlo"),
    ] {
        if bundled.join(".codex-plugin/plugin.json").is_file() {
            return Some(bundled);
        }
    }
    let development = std::env::current_dir().ok()?.join("apps/cli/plugin/zimlo");
    development
        .join(".codex-plugin/plugin.json")
        .is_file()
        .then_some(development)
}

fn resolve_command(name: &str) -> Option<PathBuf> {
    let override_name = match name {
        "codex" => "ZIMLO_CODEX_BIN",
        "claude" => "ZIMLO_CLAUDE_BIN",
        _ => return None,
    };
    if let Some(path) = std::env::var_os(override_name).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(path);
        return executable(&path).then_some(path);
    }
    let applications: &[&str] = if name == "codex" {
        &[
            "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
            "/Applications/ChatGPT.app/Contents/Resources/codex",
            "/Applications/Codex.app/Contents/Resources/codex",
        ]
    } else {
        &["/Applications/Claude.app/Contents/Resources/claude"]
    };
    let paths = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .chain(dirs::home_dir().map(|home| home.join(".local/bin")))
        .chain([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]);
    applications
        .iter()
        .map(PathBuf::from)
        .chain(paths.map(|directory| directory.join(name)))
        .find(|path| executable(path))
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = fs::metadata(path) else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    {
        true
    }
}

async fn command_output(command: &Path, arguments: &[&str]) -> Option<String> {
    let output = timeout(
        Duration::from_secs(15),
        Command::new(command).args(arguments).output(),
    )
    .await
    .ok()?
    .ok()?;
    Some(format!(
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    ))
}

async fn command_json(command: &Path, arguments: &[&str]) -> Option<Value> {
    let output = timeout(
        Duration::from_secs(15),
        Command::new(command).args(arguments).output(),
    )
    .await
    .ok()?
    .ok()?;
    output
        .status
        .success()
        .then(|| serde_json::from_slice(&output.stdout).ok())
        .flatten()
}

async fn require_command(command: &Path, arguments: &[&str]) -> Result<(), String> {
    let output = timeout(
        Duration::from_secs(20),
        Command::new(command).args(arguments).output(),
    )
    .await
    .map_err(|_| "Agent CLI 配置超时。".to_owned())?
    .map_err(display)?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_owned())
    }
}

fn read_object(path: &Path) -> Result<Map<String, Value>, String> {
    if !path.exists() {
        return Ok(Map::new());
    }
    let value: Value =
        serde_json::from_slice(&fs::read(path).map_err(display)?).map_err(display)?;
    value
        .as_object()
        .cloned()
        .ok_or_else(|| format!("无法解析 {}：根节点必须是对象。", path.display()))
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(display)?;
    }
    if path.exists() {
        let backup = path.with_extension(format!(
            "zimlo-backup-{}",
            chrono::Utc::now().timestamp_millis()
        ));
        fs::copy(path, backup).map_err(display)?;
    }
    let temporary = path.with_extension(format!("zimlo-{}.tmp", std::process::id()));
    let mut data = serde_json::to_vec_pretty(value).map_err(display)?;
    data.push(b'\n');
    fs::write(&temporary, data).map_err(display)?;
    private(&temporary).map_err(display)?;
    fs::rename(temporary, path).map_err(display)
}

fn copy_tree(source: &Path, destination: &Path) -> io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_tree(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

fn private(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

fn display(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use serde_json::Map;

    use super::{
        codex_plugin_owns_hooks, desired_user_hooks, hook_config_ready, hook_groups, merged_hooks,
        migrate_codex_hooks, read_object, shell_quote, write_json,
    };

    #[test]
    fn hook_merge_preserves_unrelated_entries_and_is_idempotent() {
        let before = serde_json::json!({ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "keep" }] }] } });
        let first = merged_hooks(
            before.as_object().expect("object").clone(),
            "codex",
            Path::new("/opt/zimlo"),
            false,
        );
        let second = merged_hooks(first.clone(), "codex", Path::new("/opt/zimlo"), false);
        assert_eq!(first, second);
        let encoded = serde_json::Value::Object(first).to_string();
        assert!(encoded.contains("keep"));
        assert!(encoded.contains("hook --provider codex"));
    }

    #[test]
    fn shell_quote_handles_single_quotes() {
        assert_eq!(shell_quote("/tmp/a'b"), "'/tmp/a'\"'\"'b'");
    }

    #[test]
    fn missing_hook_config_is_not_ready() {
        assert!(!hook_config_ready(
            &Map::new(),
            "codex",
            Path::new("/opt/zimlo")
        ));
    }

    #[test]
    fn plugin_and_cli_repairs_keep_exactly_one_three_hook_set() {
        let home = tempfile::tempdir().expect("home");
        write_json(
            &home.path().join("plugins/zimlo/.codex-plugin/plugin.json"),
            &serde_json::json!({"name": "zimlo"}),
        )
        .expect("manifest");
        write_json(&home.path().join(".agents/plugins/marketplace.json"),
            &serde_json::json!({"plugins": [{"name": "zimlo", "source": {"source": "local", "path": "./plugins/zimlo"}}]})).expect("marketplace");
        assert!(codex_plugin_owns_hooks(home.path()));
        let executable = Path::new("/opt/zimlo");
        let legacy = merged_hooks(Map::new(), "codex", executable, false);
        let repaired = desired_user_hooks(legacy, "codex", executable, false, true);
        let again = desired_user_hooks(repaired.clone(), "codex", executable, false, true);
        assert_eq!(repaired, again);
        let combined = serde_json::json!([repaired, hook_groups("codex", executable)]).to_string();
        assert_eq!(combined.matches("hook --provider codex").count(), 3);
        assert_eq!(combined.matches("--surface auto").count(), 3);
        assert!(combined.contains("Binding Zimlo session"));
    }

    #[test]
    fn migration_backs_up_all_legacy_events_and_preserves_user_handlers() {
        let home = tempfile::tempdir().expect("home");
        let path = home.path().join(".codex/hooks.json");
        let legacy = serde_json::json!({ "custom": true, "hooks": {
            "SessionStart": [{"hooks": [{"command": "'/old/zimlo' hook --provider codex --surface cli"}]}],
            "Stop": [{"matcher": "*", "hooks": [
                {"command": "'/old/zimlo' hook --provider codex --surface cli"},
                {"command": "my-review-hook", "timeout": 17}
            ]}],
            "PostToolUse": [{"hooks": [{"command": "'/old/zimlo' hook --provider codex --surface cli"}]}],
            "UserPromptSubmit": [{"hooks": [{"command": "'/old/zimlo' hook --provider codex --surface cli"}]}]
        }});
        write_json(&path, &legacy).expect("legacy");
        assert!(migrate_codex_hooks(home.path(), Path::new("/opt/zimlo")).expect("migration"));
        assert_eq!(
            serde_json::Value::Object(read_object(&path).expect("read")),
            serde_json::json!({ "custom": true, "hooks": { "Stop": [{"matcher": "*", "hooks": [{"command": "my-review-hook", "timeout": 17}]}] }})
        );
        assert!(!migrate_codex_hooks(home.path(), Path::new("/opt/zimlo")).expect("repeat"));
        let backups = std::fs::read_dir(path.parent().expect("parent"))
            .expect("list")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains("zimlo-backup"))
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            serde_json::Value::Object(read_object(&backups[0].path()).expect("backup")),
            legacy
        );
    }

    #[test]
    fn migrating_missing_or_malformed_user_config_never_creates_or_overwrites_it() {
        let home = tempfile::tempdir().expect("home");
        let executable = Path::new("/opt/zimlo");
        assert!(!migrate_codex_hooks(home.path(), executable).expect("missing"));
        let path = home.path().join(".codex/hooks.json");
        assert!(!path.exists());
        std::fs::create_dir_all(path.parent().expect("parent")).expect("directory");
        std::fs::write(&path, "invalid json").expect("write");
        assert!(migrate_codex_hooks(home.path(), executable).is_err());
        assert_eq!(std::fs::read_to_string(path).expect("read"), "invalid json");
    }
}

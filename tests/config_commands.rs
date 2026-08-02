use std::fs;
use std::process::Command;

use tempfile::tempdir;

fn holvi() -> Command {
    Command::new(env!("CARGO_BIN_EXE_holvi"))
}

#[test]
fn config_path_prints_the_resolved_path_without_loading_it() {
    let temporary = tempdir().unwrap();
    let config = temporary.path().join("missing config.json");
    let output = holvi()
        .args(["config", "path"])
        .env("HOLVI_AGENT_BRIDGE_CONFIG", &config)
        .output()
        .unwrap();

    assert!(output.status.success());
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("{}\n", config.display())
    );
    assert!(output.stderr.is_empty());
}

#[test]
fn config_edit_uses_visual_with_arguments_and_passes_the_path() {
    let temporary = tempdir().unwrap();
    let config = temporary.path().join("config with spaces.json");
    let invocation = temporary.path().join("invocation");
    let editor = format!("printf '%s\\n' --wait > '{}'", invocation.to_string_lossy());
    let output = holvi()
        .args(["config", "edit"])
        .env("HOLVI_AGENT_BRIDGE_CONFIG", &config)
        .env("VISUAL", editor)
        .env("EDITOR", "false")
        .output()
        .unwrap();

    assert!(output.status.success());
    assert_eq!(
        fs::read_to_string(invocation).unwrap(),
        format!("--wait\n{}\n", config.display())
    );
}

#[test]
fn config_edit_uses_editor_when_visual_is_empty() {
    let temporary = tempdir().unwrap();
    let config = temporary.path().join("config.json");
    let invocation = temporary.path().join("invocation");
    let editor = format!("printf '%s\\n' > '{}'", invocation.to_string_lossy());
    let output = holvi()
        .args(["config", "edit"])
        .env("HOLVI_AGENT_BRIDGE_CONFIG", &config)
        .env("VISUAL", "")
        .env("EDITOR", editor)
        .output()
        .unwrap();

    assert!(output.status.success());
    assert_eq!(
        fs::read_to_string(invocation).unwrap(),
        format!("{}\n", config.display())
    );
}

#[test]
fn config_edit_reports_an_editor_failure() {
    let temporary = tempdir().unwrap();
    let config = temporary.path().join("config.json");
    let output = holvi()
        .args(["config", "edit"])
        .env("HOLVI_AGENT_BRIDGE_CONFIG", config)
        .env("VISUAL", "false")
        .env("EDITOR", "true")
        .output()
        .unwrap();

    assert!(!output.status.success());
    assert!(
        String::from_utf8(output.stderr)
            .unwrap()
            .contains("Editor command from VISUAL failed")
    );
}

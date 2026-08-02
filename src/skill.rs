use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use clap::ValueEnum;

const SKILL_NAME: &str = "holvi";
const SKILL_BODY: &str = include_str!("skill.md");
const SKILL_DESCRIPTION: &str =
    "Use the capability-scoped Holvi CLI through an authenticated Chrome session.";

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodingAgentArg {
    Claude,
    Opencode,
    Codex,
}

struct CodingAgent {
    arg: CodingAgentArg,
    name: &'static str,
    user_parent: PathBuf,
    skill_dir: PathBuf,
    workspace_markers: &'static [&'static str],
}

impl CodingAgent {
    fn new(
        arg: CodingAgentArg,
        name: &'static str,
        user_parent: PathBuf,
        workspace_markers: &'static [&'static str],
    ) -> Self {
        let skill_dir = user_parent.join("skills").join(SKILL_NAME);
        Self {
            arg,
            name,
            user_parent,
            skill_dir,
            workspace_markers,
        }
    }

    fn is_detected(&self, cwd: &Path) -> bool {
        self.user_parent.is_dir()
            || cwd.ancestors().any(|dir| {
                self.workspace_markers
                    .iter()
                    .any(|marker| dir.join(marker).exists())
            })
    }
}

pub(crate) fn print() {
    print!("{SKILL_BODY}");
}

pub(crate) fn install(selected: &[CodingAgentArg]) -> Result<()> {
    let home =
        dirs::home_dir().ok_or_else(|| anyhow::anyhow!("cannot determine home directory"))?;
    let cwd = std::env::current_dir()?;
    install_at(&home, &cwd, selected)
}

fn install_at(home: &Path, cwd: &Path, selected: &[CodingAgentArg]) -> Result<()> {
    let agents = all_agents(home);
    let targets: Vec<&CodingAgent> = if selected.is_empty() {
        agents
            .iter()
            .filter(|agent| agent.is_detected(cwd))
            .collect()
    } else {
        agents
            .iter()
            .filter(|agent| selected.contains(&agent.arg))
            .collect()
    };

    if targets.is_empty() {
        bail!(
            "no supported coding agents detected (expected ~/.claude, ~/.config/opencode, ~/.codex, or workspace agent config); use --agent to choose a target"
        );
    }

    let content = skill_content();
    for target in targets {
        let path = target.skill_dir.join("SKILL.md");
        fs::create_dir_all(&target.skill_dir)?;
        fs::write(&path, content.as_bytes())?;
        println!(
            "installed {SKILL_NAME} skill for {} at {}",
            target.name,
            shrink_home(&path, home)
        );
    }
    Ok(())
}

fn all_agents(home: &Path) -> Vec<CodingAgent> {
    vec![
        CodingAgent::new(
            CodingAgentArg::Claude,
            "Claude Code",
            home.join(".claude"),
            &[".claude"],
        ),
        CodingAgent::new(
            CodingAgentArg::Opencode,
            "OpenCode",
            home.join(".config").join("opencode"),
            &[".opencode"],
        ),
        CodingAgent::new(
            CodingAgentArg::Codex,
            "Codex",
            home.join(".codex"),
            &[".codex"],
        ),
    ]
}

fn skill_content() -> String {
    format!("---\nname: {SKILL_NAME}\ndescription: {SKILL_DESCRIPTION}\n---\n\n{SKILL_BODY}")
}

fn shrink_home(path: &Path, home: &Path) -> String {
    path.strip_prefix(home)
        .map(|relative| format!("~/{}", relative.display()))
        .unwrap_or_else(|_| path.display().to_string())
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn installs_an_explicit_agent_skill() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        fs::create_dir(&home).unwrap();

        install_at(&home, &home, &[CodingAgentArg::Claude]).unwrap();

        let installed = fs::read_to_string(home.join(".claude/skills/holvi/SKILL.md")).unwrap();
        assert!(installed.starts_with("---\nname: holvi\n"));
        assert!(installed.ends_with(SKILL_BODY));
        assert!(!home.join(".codex/skills/holvi/SKILL.md").exists());
    }

    #[test]
    fn installs_for_detected_user_and_workspace_agents() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        let repo = temp.path().join("repo/project");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::create_dir_all(repo.join(".opencode")).unwrap();

        install_at(&home, &repo, &[]).unwrap();

        assert!(home.join(".claude/skills/holvi/SKILL.md").exists());
        assert!(home.join(".config/opencode/skills/holvi/SKILL.md").exists());
        assert!(home.join(".codex/skills/holvi/SKILL.md").exists());
    }

    #[test]
    fn reports_when_no_agent_is_detected() {
        let temp = TempDir::new().unwrap();
        let home = temp.path().join("home");
        fs::create_dir(&home).unwrap();

        let error = install_at(&home, &home, &[]).unwrap_err().to_string();
        assert!(error.contains("no supported coding agents detected"));
        assert!(error.contains("use --agent to choose a target"));
    }

    #[test]
    fn skill_teaches_safe_agent_workflows() {
        assert!(SKILL_BODY.contains("holvi capabilities"));
        assert!(SKILL_BODY.contains("dry run"));
        assert!(SKILL_BODY.contains("explicit authorization"));
        assert!(SKILL_BODY.contains("debtUuid"));
        assert!(SKILL_BODY.contains("holvi attachments delete"));
        assert!(SKILL_BODY.contains("irreversible"));
        assert!(SKILL_BODY.contains("post-delete debt read"));
        assert!(SKILL_BODY.contains("bookkeeping.write"));
        assert!(SKILL_BODY.contains("bookkeeping set-description"));
        assert!(SKILL_BODY.contains("never retries"));
        assert!(SKILL_BODY.contains("named operations"));
    }
}

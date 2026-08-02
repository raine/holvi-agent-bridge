use serde::Serialize;

pub const ACTION_CAPABILITIES: [(&str, &[&str]); 4] = [
    ("doctor", &["transactions.read"]),
    ("transactions", &["transactions.read"]),
    ("preview", &["transactions.read"]),
    ("upload", &["transactions.read", "attachments.write"]),
];

pub fn required_capabilities(action: &str) -> Option<&'static [&'static str]> {
    ACTION_CAPABILITIES
        .iter()
        .find_map(|(name, capabilities)| (*name == action).then_some(*capabilities))
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct EnabledActions {
    doctor: bool,
    transactions: bool,
    preview: bool,
    upload: bool,
}

pub fn enabled_actions(capabilities: &[String]) -> EnabledActions {
    let enabled = |action| {
        required_capabilities(action).is_some_and(|required| {
            required
                .iter()
                .all(|item| capabilities.iter().any(|enabled| enabled == item))
        })
    };
    EnabledActions {
        doctor: enabled("doctor"),
        transactions: enabled("transactions"),
        preview: enabled("preview"),
        upload: enabled("upload"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_actions_have_no_capability_mapping() {
        assert_eq!(required_capabilities("fetch"), None);
    }

    #[test]
    fn read_only_scope_disables_uploads() {
        let enabled = enabled_actions(&["transactions.read".into()]);
        assert!(enabled.doctor && enabled.transactions && enabled.preview);
        assert!(!enabled.upload);
    }

    #[test]
    fn upload_requires_both_capabilities() {
        let enabled = enabled_actions(&["transactions.read".into(), "attachments.write".into()]);
        assert!(enabled.upload);
    }
}

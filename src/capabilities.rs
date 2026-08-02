use std::collections::BTreeMap;

pub const ACTION_CAPABILITIES: [(&str, &[&str]); 8] = [
    ("doctor", &[]),
    ("transactions", &["transactions.read"]),
    ("preview", &["transactions.read"]),
    ("upload", &["transactions.read", "attachments.write"]),
    ("bookkeeping.get", &["bookkeeping.read"]),
    ("bookkeeping.categories", &["bookkeeping.read"]),
    ("bookkeeping.suggestions", &["bookkeeping.read"]),
    ("audit.list", &["audit.read"]),
];

pub fn required_capabilities(action: &str) -> Option<&'static [&'static str]> {
    ACTION_CAPABILITIES
        .iter()
        .find_map(|(name, capabilities)| (*name == action).then_some(*capabilities))
}

pub fn enabled_actions(capabilities: &[String]) -> BTreeMap<&'static str, bool> {
    ACTION_CAPABILITIES
        .iter()
        .map(|(action, required)| {
            let enabled = required
                .iter()
                .all(|item| capabilities.iter().any(|capability| capability == item));
            (*action, enabled)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_actions_have_no_capability_mapping() {
        assert_eq!(required_capabilities("fetch"), None);
    }

    #[test]
    fn read_only_scope_disables_other_capabilities() {
        let enabled = enabled_actions(&["transactions.read".into()]);
        assert_eq!(enabled.get("doctor"), Some(&true));
        assert_eq!(enabled.get("transactions"), Some(&true));
        assert_eq!(enabled.get("preview"), Some(&true));
        assert_eq!(enabled.get("upload"), Some(&false));
        assert_eq!(enabled.get("bookkeeping.get"), Some(&false));
        assert_eq!(enabled.get("audit.list"), Some(&false));
    }

    #[test]
    fn each_new_capability_enables_only_its_actions() {
        let bookkeeping = enabled_actions(&["bookkeeping.read".into()]);
        assert_eq!(bookkeeping.get("bookkeeping.get"), Some(&true));
        assert_eq!(bookkeeping.get("bookkeeping.categories"), Some(&true));
        assert_eq!(bookkeeping.get("bookkeeping.suggestions"), Some(&true));
        assert_eq!(bookkeeping.get("audit.list"), Some(&false));

        let audit = enabled_actions(&["audit.read".into()]);
        assert_eq!(audit.get("audit.list"), Some(&true));
        assert_eq!(audit.get("bookkeeping.get"), Some(&false));
    }

    #[test]
    fn upload_requires_both_capabilities() {
        let enabled = enabled_actions(&["transactions.read".into(), "attachments.write".into()]);
        assert_eq!(enabled.get("upload"), Some(&true));
    }
}

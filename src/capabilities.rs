use serde::ser::{Serialize, SerializeMap, Serializer};

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

#[derive(Debug, PartialEq, Eq)]
pub struct EnabledActions(Vec<(&'static str, bool)>);

impl EnabledActions {
    #[cfg(test)]
    fn get(&self, action: &str) -> Option<bool> {
        self.0
            .iter()
            .find_map(|(name, enabled)| (*name == action).then_some(*enabled))
    }
}

impl Serialize for EnabledActions {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (action, enabled) in &self.0 {
            map.serialize_entry(action, enabled)?;
        }
        map.end()
    }
}

pub fn enabled_actions(capabilities: &[String]) -> EnabledActions {
    EnabledActions(
        ACTION_CAPABILITIES
            .iter()
            .map(|(action, required)| {
                let enabled = required
                    .iter()
                    .all(|item| capabilities.iter().any(|capability| capability == item));
                (*action, enabled)
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use super::*;

    #[test]
    fn action_policy_matches_the_extension_fixture() {
        let fixture: BTreeMap<String, Vec<String>> =
            serde_json::from_str(include_str!("../capability-policy.json")).unwrap();
        let native: BTreeMap<String, Vec<String>> = ACTION_CAPABILITIES
            .iter()
            .map(|(action, capabilities)| {
                (
                    (*action).to_owned(),
                    capabilities
                        .iter()
                        .map(|value| (*value).to_owned())
                        .collect(),
                )
            })
            .collect();
        assert_eq!(native, fixture);

        let configured: BTreeSet<_> = crate::config::SUPPORTED_CAPABILITIES.into_iter().collect();
        let required: BTreeSet<_> = ACTION_CAPABILITIES
            .iter()
            .flat_map(|(_, capabilities)| capabilities.iter().copied())
            .collect();
        assert_eq!(configured, required);
    }

    #[test]
    fn unknown_actions_have_no_capability_mapping() {
        assert_eq!(required_capabilities("fetch"), None);
    }

    #[test]
    fn read_only_scope_disables_other_capabilities() {
        let enabled = enabled_actions(&["transactions.read".into()]);
        assert_eq!(enabled.get("doctor"), Some(true));
        assert_eq!(enabled.get("transactions"), Some(true));
        assert_eq!(enabled.get("preview"), Some(true));
        assert_eq!(enabled.get("upload"), Some(false));
        assert_eq!(enabled.get("bookkeeping.get"), Some(false));
        assert_eq!(enabled.get("audit.list"), Some(false));
    }

    #[test]
    fn each_new_capability_enables_only_its_actions() {
        let bookkeeping = enabled_actions(&["bookkeeping.read".into()]);
        assert_eq!(bookkeeping.get("bookkeeping.get"), Some(true));
        assert_eq!(bookkeeping.get("bookkeeping.categories"), Some(true));
        assert_eq!(bookkeeping.get("bookkeeping.suggestions"), Some(true));
        assert_eq!(bookkeeping.get("audit.list"), Some(false));

        let audit = enabled_actions(&["audit.read".into()]);
        assert_eq!(audit.get("audit.list"), Some(true));
        assert_eq!(audit.get("bookkeeping.get"), Some(false));
    }

    #[test]
    fn upload_requires_both_capabilities() {
        let enabled = enabled_actions(&["transactions.read".into(), "attachments.write".into()]);
        assert_eq!(enabled.get("upload"), Some(true));
    }

    #[test]
    fn serialization_preserves_existing_operation_order() {
        let value = serde_json::to_string(&enabled_actions(&[])).unwrap();
        assert!(
            value.starts_with(
                r#"{"doctor":true,"transactions":false,"preview":false,"upload":false,"#
            )
        );
    }
}

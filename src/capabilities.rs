use serde::ser::{Serialize, SerializeMap, Serializer};

use crate::protocol::Action;

pub const ACTION_CAPABILITIES: [(&str, &[&str]); 12] = [
    ("doctor", &[]),
    ("transactions.list", &["transactions.read"]),
    ("debts.get", &["transactions.read"]),
    ("comments.list", &["transactions.read"]),
    ("comments.create", &["transactions.read", "comments.write"]),
    (
        "attachments.upload",
        &["transactions.read", "attachments.write"],
    ),
    (
        "attachments.delete",
        &["transactions.read", "attachments.delete"],
    ),
    ("bookkeeping.get", &["bookkeeping.read"]),
    ("bookkeeping.categories", &["bookkeeping.read"]),
    ("bookkeeping.suggestions", &["bookkeeping.read"]),
    ("bookkeeping.set-description", &["bookkeeping.write"]),
    ("audit.list", &["audit.read"]),
];

pub fn required_capabilities(action: &Action) -> &'static [&'static str] {
    match action {
        Action::HostRestart(_) | Action::Doctor(_) => &[],
        Action::TransactionsList(_) | Action::DebtGet(_) | Action::CommentsList(_) => {
            &["transactions.read"]
        }
        Action::CommentsCreate(_) => &["transactions.read", "comments.write"],
        Action::AttachmentUpload(_) => &["transactions.read", "attachments.write"],
        Action::AttachmentDelete(_) => &["transactions.read", "attachments.delete"],
        Action::BookkeepingGet(_)
        | Action::BookkeepingCategories(_)
        | Action::BookkeepingSuggestions(_) => &["bookkeeping.read"],
        Action::BookkeepingSetDescription(_) => &["bookkeeping.write"],
        Action::AuditList(_) => &["audit.read"],
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct EnabledActions(Vec<(&'static str, bool)>);

impl EnabledActions {
    pub fn iter(&self) -> impl Iterator<Item = (&'static str, bool)> + '_ {
        self.0.iter().copied()
    }

    #[cfg(test)]
    fn get(&self, action: &str) -> Option<bool> {
        self.iter()
            .find_map(|(name, enabled)| (name == action).then_some(enabled))
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
    use std::path::PathBuf;

    use crate::protocol::{
        AttachmentDeleteParams, AuditListParams, BookkeepingDescriptionParams, CommentCreateParams,
        DebtParams, EmptyParams, TransactionParams, UploadParams,
    };

    use super::*;

    #[test]
    fn action_policy_matches_the_bridge_contract() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../bridge-contract.json")).unwrap();
        let fixture: BTreeMap<String, Vec<String>> =
            serde_json::from_value(contract["actions"].clone()).unwrap();
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
    fn typed_actions_match_the_capability_policy() {
        let actions = [
            Action::Doctor(EmptyParams {}),
            Action::TransactionsList(TransactionParams {
                from: String::new(),
                to: String::new(),
                missing_attachments: false,
            }),
            Action::DebtGet(DebtParams {
                debt_uuid: String::new(),
            }),
            Action::CommentsList(DebtParams {
                debt_uuid: String::new(),
            }),
            Action::CommentsCreate(CommentCreateParams {
                debt_uuid: String::new(),
                content: String::new(),
                confirmed: true,
            }),
            Action::AttachmentUpload(UploadParams {
                debt_uuid: String::new(),
                file_path: PathBuf::new(),
                confirmed: true,
            }),
            Action::AttachmentDelete(AttachmentDeleteParams {
                debt_uuid: String::new(),
                attachment_code: String::new(),
                confirmed: false,
            }),
            Action::BookkeepingGet(DebtParams {
                debt_uuid: String::new(),
            }),
            Action::BookkeepingCategories(EmptyParams {}),
            Action::BookkeepingSuggestions(DebtParams {
                debt_uuid: String::new(),
            }),
            Action::BookkeepingSetDescription(BookkeepingDescriptionParams {
                debt_uuid: String::new(),
                item_uuid: String::new(),
                description: String::new(),
                confirmed: false,
            }),
            Action::AuditList(AuditListParams { limit: 1 }),
        ];
        let typed: Vec<_> = actions
            .iter()
            .map(|action| (action.name(), required_capabilities(action)))
            .collect();
        assert_eq!(typed, ACTION_CAPABILITIES);
    }

    #[test]
    fn read_only_scope_disables_other_capabilities() {
        let enabled = enabled_actions(&["transactions.read".into()]);
        assert_eq!(enabled.get("doctor"), Some(true));
        assert_eq!(enabled.get("transactions.list"), Some(true));
        assert_eq!(enabled.get("debts.get"), Some(true));
        assert_eq!(enabled.get("attachments.upload"), Some(false));
        assert_eq!(enabled.get("bookkeeping.get"), Some(false));
        assert_eq!(enabled.get("audit.list"), Some(false));
    }

    #[test]
    fn each_new_capability_enables_only_its_actions() {
        let bookkeeping = enabled_actions(&["bookkeeping.read".into()]);
        assert_eq!(bookkeeping.get("bookkeeping.get"), Some(true));
        assert_eq!(bookkeeping.get("bookkeeping.categories"), Some(true));
        assert_eq!(bookkeeping.get("bookkeeping.suggestions"), Some(true));
        assert_eq!(bookkeeping.get("bookkeeping.set-description"), Some(false));
        assert_eq!(bookkeeping.get("audit.list"), Some(false));

        let bookkeeping_write = enabled_actions(&["bookkeeping.write".into()]);
        assert_eq!(
            bookkeeping_write.get("bookkeeping.set-description"),
            Some(true)
        );
        assert_eq!(bookkeeping_write.get("bookkeeping.get"), Some(false));

        let audit = enabled_actions(&["audit.read".into()]);
        assert_eq!(audit.get("audit.list"), Some(true));
        assert_eq!(audit.get("bookkeeping.get"), Some(false));
    }

    #[test]
    fn attachment_deletion_requires_its_destructive_capability_and_read_scope() {
        let read_only = enabled_actions(&["transactions.read".into()]);
        assert_eq!(read_only.get("attachments.delete"), Some(false));

        let delete_only = enabled_actions(&["attachments.delete".into()]);
        assert_eq!(delete_only.get("attachments.delete"), Some(false));

        let enabled = enabled_actions(&["transactions.read".into(), "attachments.delete".into()]);
        assert_eq!(enabled.get("attachments.delete"), Some(true));
        assert_eq!(enabled.get("attachments.upload"), Some(false));
    }

    #[test]
    fn upload_requires_both_capabilities() {
        let enabled = enabled_actions(&["transactions.read".into(), "attachments.write".into()]);
        assert_eq!(enabled.get("attachments.upload"), Some(true));
    }

    #[test]
    fn serialization_preserves_existing_operation_order() {
        let value = serde_json::to_string(&enabled_actions(&[])).unwrap();
        assert!(value.starts_with(
            r#"{"doctor":true,"transactions.list":false,"debts.get":false,"comments.list":false,"#
        ));
    }
}

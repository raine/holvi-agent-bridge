use std::fs::Metadata;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};

pub fn current_user_uid() -> u32 {
    // SAFETY: getuid has no preconditions and cannot fail.
    unsafe { libc::getuid() }
}

pub fn is_regular_file(metadata: &Metadata) -> bool {
    metadata.file_type().is_file()
}

pub fn is_socket(metadata: &Metadata) -> bool {
    metadata.file_type().is_socket()
}

pub fn is_owned_by_current_user(metadata: &Metadata) -> bool {
    metadata.uid() == current_user_uid()
}

pub fn has_mode_0600(metadata: &Metadata) -> bool {
    metadata.permissions().mode() & 0o777 == 0o600
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::os::unix::fs::{PermissionsExt, symlink};
    use std::os::unix::net::UnixListener;

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn identifies_current_user_mode_0600_regular_files() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        fs::write(&path, b"{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        let metadata = fs::symlink_metadata(&path).unwrap();

        assert!(is_regular_file(&metadata));
        assert!(!is_socket(&metadata));
        assert!(is_owned_by_current_user(&metadata));
        assert!(has_mode_0600(&metadata));
    }

    #[test]
    fn rejects_private_modes_other_than_0600() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("bridge.sock");
        let _listener = UnixListener::bind(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let metadata = fs::symlink_metadata(&path).unwrap();

        assert!(is_socket(&metadata));
        assert!(!is_regular_file(&metadata));
        assert!(is_owned_by_current_user(&metadata));
        assert!(!has_mode_0600(&metadata));
    }

    #[test]
    fn rejects_symlinks_as_regular_files() {
        let directory = tempdir().unwrap();
        let target = directory.path().join("config.json");
        let link = directory.path().join("config-link.json");
        fs::write(&target, b"{}").unwrap();
        symlink(&target, &link).unwrap();
        let metadata = fs::symlink_metadata(&link).unwrap();

        assert!(!is_regular_file(&metadata));
        assert!(!is_socket(&metadata));
    }

    #[test]
    fn rejects_group_or_other_permissions() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("config.json");
        fs::write(&path, b"{}").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let metadata = fs::symlink_metadata(&path).unwrap();

        assert!(!has_mode_0600(&metadata));
    }
}

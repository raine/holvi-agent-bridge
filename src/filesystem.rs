use std::fs::Metadata;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
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

pub fn resolve_export_root(path: &Path) -> Result<PathBuf> {
    ensure!(path.is_absolute(), "Export root must be absolute.");
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("Unable to inspect export root: {}", path.display()))?;
    ensure!(
        metadata.file_type().is_dir() && !metadata.file_type().is_symlink(),
        "Export root must be an existing directory, not a symlink."
    );
    ensure!(
        is_owned_by_current_user(&metadata),
        "Export root must be owned by the current user."
    );
    let canonical = path.canonicalize()?;
    ensure!(
        canonical.parent().is_some() && canonical != Path::new("/"),
        "Export root is too broad."
    );
    Ok(canonical)
}

pub fn resolve_export_directory(path: &Path, roots: &[PathBuf]) -> Result<PathBuf> {
    let directory = resolve_export_root(path)?;
    let roots = roots
        .iter()
        .map(|root| resolve_export_root(root))
        .collect::<Result<Vec<_>>>()?;
    ensure!(
        roots.iter().any(|root| directory.starts_with(root)),
        "Output directory is outside approved export roots."
    );
    Ok(directory)
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
    fn authorizes_only_real_directories_below_export_roots() {
        let root = tempdir().unwrap();
        let child = root.path().join("exports");
        fs::create_dir(&child).unwrap();
        let root = root.path().canonicalize().unwrap();
        assert_eq!(
            resolve_export_directory(&child, std::slice::from_ref(&root)).unwrap(),
            child.canonicalize().unwrap()
        );

        let outside = tempdir().unwrap();
        assert!(resolve_export_directory(outside.path(), std::slice::from_ref(&root)).is_err());
        let link = root.join("link");
        symlink(&child, &link).unwrap();
        assert!(resolve_export_directory(&link, std::slice::from_ref(&root)).is_err());
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

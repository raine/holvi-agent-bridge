set positional-arguments := true
set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# Run every project check through checkle
check:
    checkle run all

# Run the full gate and reject generated changes
check-ci: check
    #!/usr/bin/env bash
    set -euo pipefail
    if ! git diff --quiet || ! git diff --cached --quiet; then
        echo "Error: check caused uncommitted changes"
        git diff --stat
        exit 1
    fi

# Format Rust and extension sources
format:
    cargo fmt --all
    bun run format

# Build the native binary and Chrome extension
build:
    cargo build --all-targets --locked
    bun run build

# Run Rust tests through checkle
test:
    checkle run test

# Run extension checks through checkle
check-extension:
    checkle run extension

# Regenerate embedded extension artifacts
sync-extension-artifacts:
    bun run sync:artifacts

# Install the release binary globally
install:
    cargo install --offline --path . --locked

# Install the debug binary globally via symlink
install-dev:
    cargo build
    ln -sf "$(pwd)/target/debug/holvi" "$HOME/.cargo/bin/holvi"

# Run the CLI
run *ARGS:
    cargo run -- "$@"

# Synchronize every tracked build version before release validation
_release-version version:
    @bun scripts/sync-release-version.ts {{version}}
    @bun run sync:artifacts

# Internal release helper
_release bump:
    @cargo-release {{bump}}

# Release a new patch version
release *ARGS:
    @just _release patch {{ARGS}}

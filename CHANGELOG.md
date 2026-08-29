---
title: Changelog
description: Release notes for Holvi Agent Bridge.
---

## Unreleased

- Include exact payment timing, direction, status, recipient bank details,
  structured references, scheduling, and transaction classification in
  `transactions get` output for payment and invoice reconciliation.
- Print terminal-safe, command-aware human output with responsive tables,
  ordered detail sections, explicit empty and truncated states, guarded
  third-party text, and distinct write outcomes. Stable structured responses
  remain available through `--json` across all command groups.
- Create one-off EUR payment drafts and confirm reviewed drafts through Holvi's
  mobile-app 2FA flow with independent capabilities.

## v0.1.4 (2026-08-14)

- Remove download size limit configuration from installation.

## v0.1.3 (2026-08-14)

- Reinstall interactively with settings and capability selections remembered
  from the existing private configuration.
- Update Rust and extension tooling dependencies to current releases and require
  Rust 1.88 or later for source builds.
- View ledger, available, and blocked balances with `accounts list`.

## v0.1.2 (2026-08-12)

- Include value and booking dates, counterparty, bank reference, payment
  message, and the Holvi archive identifier in `transactions get` output.
- Discover payment accounts with a dedicated read capability.
- Export account statements, journals, ledgers, CAMT.052 files, and invoicing
  reports into approved local directories.
- Create, inspect, list, and download All-in-One PDF and ZIP report jobs.
- Stream report and attachment downloads through protocol version 2 with bounded
  chunks, atomic private files, byte counts, and SHA-256 integrity metadata.
- Traverse bounded bookkeeping and historical activity pages with explicit
  truncation metadata and source-supported filters.
- Separate report reads, report generation, attachment reads, and account reads
  into dedicated capabilities.

## v0.1.1 (2026-08-02)

- Read and create internal transaction comments with dry-run confirmation and no
  push notifications.
- View detailed card, account, exchange, merchant, debt, and attachment
  information for a transaction.
- Target transaction commands with either a debt UUID or its Holvi payment-page
  URL.
- Preview and delete one selected attachment with explicit confirmation and
  post-delete verification.
- Upload receipts to debts that already have attachments while verifying that
  existing files remain unchanged.
- Preview and replace a bookkeeping line-item description with scoped access and
  post-write verification.
- Infer missing incoming or outgoing transaction directions from signed amounts.
- Detect ambiguous transaction matches instead of selecting an arbitrary
  payment.

## v0.1.0 (2026-08-02)

- Initial release of Holvi Agent Bridge, which lets local agents use selected
  Holvi features through a signed-in Chromium browser session

---
title: Changelog
description: Release notes for Holvi Agent Bridge.
---

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

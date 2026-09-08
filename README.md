# Holvi Agent Bridge

`holvi` lets coding agents work with one Holvi company through your signed-in
Chrome session. Credentials stay in Chrome, and the bridge only permits the
capabilities, account, and local folders you approve.

Reads include transactions, bookkeeping, account activity, reports, and
attachments. Writes use a dry run by default and require `--yes` before changing
Holvi.

## Requirements

- macOS on Apple Silicon or Linux on x86-64
- Google Chrome
- A signed-in Holvi company tab that stays open while the CLI accesses Holvi
- The company group URL and payment account UUID you want to use

## Quick start

### 1. Install the CLI

With Homebrew:

```sh
brew install raine/holvi-agent-bridge/holvi
```

Or with the release installer:

```sh
curl -fsSL https://raw.githubusercontent.com/raine/holvi-agent-bridge/main/scripts/install | bash
```

### 2. Configure the bridge

Sign in to Holvi and open the payment account's transaction feed, then run:

```sh
holvi install
```

The interactive setup asks for:

- the full company group URL
- the payment account UUID from the `payments-feed/<uuid>/` URL
- the capabilities and approved folders the agent may use

A later install uses the saved configuration as its defaults.

### 3. Load the Chrome extension

The installer prints the unpacked extension directory. Load it once in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Select **Load unpacked** and choose the printed extension directory.
4. Reload the signed-in Holvi tab.

### 4. Verify the connection

```sh
holvi doctor
```

`doctor` checks the local bridge, Chrome connection, signed-in company, payment
account, configured capabilities, and a permitted Holvi operation.

## Use with a coding agent

Install the bundled skill so supported coding agents know how to use the CLI
safely:

```sh
holvi skill install
```

Claude Code, OpenCode, and Codex are supported. Run `holvi skill` to print the
instructions without installing them, or select one integration explicitly:

```sh
holvi skill install --agent claude
```

## Capabilities

Each operation requires its capability to be enabled during setup.

| Capability | Allows |
| --- | --- |
| `transactions.read` | List and inspect transactions and comments |
| `accounts.read` | List company payment accounts and balances |
| `bookkeeping.read` | Read bookkeeping documents, categories, and suggestions |
| `audit.read` | Read historical company activity |
| `reports.read` | List and download reports into approved export folders |
| `attachments.read` | Download debt attachments into approved export folders |
| `comments.write` | Create internal transaction comments |
| `attachments.write` | Upload receipts from approved receipt folders |
| `attachments.delete` | Delete one selected attachment |
| `bookkeeping.write` | Replace one bookkeeping line-item description |
| `reports.generate` | Create asynchronous report jobs |
| `payments.write` | Preview and create one-off EUR payment drafts |
| `payments.send` | Review and confirm payment drafts through mobile-app 2FA |

Some operations combine capabilities. For example, attachment uploads and
comments also require `transactions.read`, while attachment downloads require
`bookkeeping.read`.

Inspect the active configuration with:

```sh
holvi capabilities
holvi config path
```

Run `holvi install` again to change the company, account, capabilities, or
approved folders.

## Output modes

Data commands print concise, command-aware human-readable output by default.
Collections use compact responsive tables, detail commands use ordered sections,
and writes distinguish previews, reviews, accepted requests, and verified
results. Untrusted terminal text is sanitized while documented values are
preserved. Pass `--json` for the stable structured response and exact field
types needed by machine integrations.

Warnings call out incomplete listings and dangerous or ambiguous operations.
Empty collections have explicit messages, optional fields do not create noisy
placeholder rows, and narrow terminals hide lower-priority table columns with a
note directing users to `--json`.

Commands whose result is intentionally plain stay plain. In particular,
`config path` prints a path, `skill` prints the installed skill text, and file
downloads print the saved path. Pass `--json` to a download command when its
full path, media type, size, and checksum response is needed.

## Common commands

| Task | Command |
| --- | --- |
| Payment accounts and balances | `holvi accounts list` |
| Transactions | `holvi transactions list` or `get` |
| Internal comments | `holvi transactions comments list` or `create` |
| Bookkeeping | `holvi bookkeeping list`, `get`, `categories`, or `suggestions` |
| Historical activity | `holvi audit types` or `list` |
| Reports | `holvi reports types`, `export`, or `jobs` |
| Attachments | `holvi attachments upload`, `download`, or `delete` |
| Outgoing payments | `holvi payments create` or `send` |

For example:

```sh
holvi transactions list --from 2026-01-01 --to 2026-01-31
holvi transactions get --debt DEBT_UUID
holvi transactions get --debt DEBT_UUID --json
```

Date ranges are inclusive and use `YYYY-MM-DD`. Use debt, item, attachment, and
report IDs returned by Holvi commands instead of inventing them.

Run `holvi --help` or `holvi <command> --help` for all commands, accepted values,
and options.

## Writes and dry runs

Commands that change Holvi show a dry run unless `--yes` is present. Check the
exact target and proposed change, then repeat the same command with `--yes` only
when you want to proceed.

For example, preview a receipt upload:

```sh
holvi attachments upload \
  --debt DEBT_UUID \
  --file /absolute/path/to/receipt.pdf
```

After checking the preview:

```sh
holvi attachments upload \
  --debt DEBT_UUID \
  --file /absolute/path/to/receipt.pdf \
  --yes
```

The same confirmation pattern applies to comments, bookkeeping description
changes, report generation, and attachment deletion. Attachment deletion is
irreversible. Do not retry a failed or ambiguous write without inspecting the
current Holvi state first.

### Outgoing payments

Payment creation and sending use independent capabilities and confirmations.
Create a dry-run proposal first:

```sh
holvi payments create \
  --account PAYMENT_ACCOUNT_UUID \
  --recipient-name "Example Recipient" \
  --iban FI2112345600000785 \
  --amount 123.45 \
  --message "Invoice 123"
```

Repeat it with `--yes` to create one draft. Review that draft before sending:

```sh
holvi payments send --debt DEBT_UUID
```

The review returns a SHA-256 digest bound to the authoritative recipient,
account, amount, currency, reference, payment state, and payee-verification
result. Confirm that exact review and approve it in the Holvi mobile app:

```sh
holvi payments send \
  --debt DEBT_UUID \
  --review-digest REVIEW_DIGEST \
  --yes
```

The bridge reports success only after mobile approval and an authoritative debt
read proves a confirmed payment state. Inspect Holvi before retrying any failed
or ambiguous payment operation.

## Download files

Downloads require the matching read capabilities and an existing output
directory under an approved export folder.

```sh
holvi attachments download \
  --debt DEBT_UUID \
  --attachment ATTACHMENT_CODE \
  --output /absolute/path/to/exports
```

Report exports and completed report jobs use the same approved folder rules. The
bridge verifies each file and refuses to replace an existing file.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| Chrome connection is unavailable | Open and reload the signed-in Holvi company tab |
| The wrong company or account is active | Check the configured group and payment account, then run `holvi doctor` |
| A capability is missing | Run `holvi install` and enable it |
| An upload is rejected | Use a supported file under an approved receipt folder |
| A download is rejected | Use an existing directory under an approved export folder |
| The extension does not connect | Reload the unpacked extension and the Holvi tab |

Use `holvi config edit` to open the private configuration in your editor.

## Security summary

- Holvi credentials and authentication tokens stay inside Chrome.
- Every request is restricted to the configured company. Transaction-scoped
  commands also validate the configured payment account.
- Capabilities limit which operations the bridge accepts.
- Uploads and downloads stay within explicitly approved folders.
- Downloads never replace existing files.
- Writes require an explicit confirmation and are verified against Holvi.
- Attachment deletion has a separate capability because it is irreversible.

## Related projects

The bridge automatically sends activity events and a read-only page request every
two minutes while connected to the configured Holvi company tab. Keep that tab
open during longer agent workflows. Closing the tab or disabling the extension
stops refreshes. Agent commands (including receipt uploads) enable refreshes for
30 minutes from the latest command. Opening a tab or sending a heartbeat does
not extend this window. After it expires, Holvi can log out normally; the bridge
does not force logout. Restarting the extension also resets the window.
Refreshes cannot prevent server-enforced expiry or sign you back in.
Holvi Session Keeper is not required.

For companies using Lemonaid, see
[Lemonaid Agent Bridge](https://github.com/raine/lemonaid-agent-bridge).

## Build from source

Building requires Rust 1.88 or later, Bun, and the locked dependencies:

```sh
bun install --frozen-lockfile
bun run sync:artifacts
cargo build --locked
```

This project is licensed under the [MIT License](LICENSE). See
[CHANGELOG.md](CHANGELOG.md) for release notes.

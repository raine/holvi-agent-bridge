# Holvi Agent Bridge

`holvi-agent-bridge` gives local agents capability-scoped access to Holvi
through an existing signed-in Chrome session.

Chrome acts as the authentication vault. The agent uses a native `holvi` CLI and
does not need to navigate through the Holvi site. The bridge exposes named
operations instead of arbitrary authenticated HTTP requests, so each Holvi area
can be approved independently.

Receipt handling is the first workflow built on the bridge. It is not the
boundary of the project.

## Features

- List and filter transactions from one configured Holvi payment account.
- Inspect debt and bookkeeping details without exposing unprojected API data.
- List bookkeeping categories and category suggestions for a debt.
- Review a bounded, newest-first page of recent pool activity.
- Dry-run receipt attachments, require explicit write confirmation, and verify
  attachment state before and after upload.
- Keep Holvi credentials in Chrome while enforcing capabilities in both the
  native host and extension.
- Install an agent-facing skill for Claude Code, OpenCode, or Codex.

## Requirements

Runtime requirements:

- macOS or Linux
- Google Chrome
- a Holvi account with access to the target company
- local directories containing any files the agent may attach

The `holvi` executable contains the complete native bridge and the compiled
Chrome extension. It has no Node or Bun runtime dependency.

Building from source requires Rust 1.85 or later. Extension development also
uses Bun and the dependencies in `package.json`.

## Getting started

### Install the bridge

Build and install the native binary:

```sh
cargo install --path . --locked
```

### Teach a coding agent

Print the agent-facing CLI primer to standard output:

```sh
holvi skill
```

Install it into every detected coding-agent skill directory:

```sh
holvi skill install
```

Claude Code, OpenCode, and Codex are supported. Choose one or more explicit
targets when automatic detection is not appropriate:

```sh
holvi skill install --agent claude --agent codex
```

The installed skill teaches the agent how to inspect capabilities, distinguish
payment and debt UUIDs, use bounded read operations, dry-run receipt uploads,
and preserve the bridge's security boundary.

### Configure Holvi

Sign in to Holvi in Chrome. Open the company group and its payment account
transaction feed. Copy:

- the full group URL, such as
  `https://account.app.holvi.com/group/AbC123+example-company/`
- the payment account UUID from the `payments-feed/<uuid>/` URL
- any local attachment directories the enabled capabilities may read

Register the native host with the capabilities required by the agent:

```sh
holvi install \
  --group-url 'https://account.app.holvi.com/group/AbC123+example-company/' \
  --account '11111111-1111-4111-8111-111111111111' \
  --capability transactions.read \
  --capability attachments.write \
  --receipt-root '/absolute/path/to/receipts' \
  --yes
```

A read-only installation omits `attachments.write` and does not need a receipt
root:

```sh
holvi install \
  --group-url 'https://account.app.holvi.com/group/AbC123+example-company/' \
  --account '11111111-1111-4111-8111-111111111111' \
  --capability transactions.read \
  --yes
```

The installer writes the private configuration, installs the Chrome native host
manifest, and extracts the embedded extension into the application support
directory. Its JSON output contains the unpacked extension path. Open
`chrome://extensions`, enable Developer mode, choose Load unpacked, and select
that directory.

### Verify the connection

Confirm that Chrome shows this extension ID:

```text
oeedcemphbobfehfmcllmjhhhjgahgeb
```

The native host accepts connections from that exact extension ID. Reload the
signed-in Holvi group tab after loading the extension, then verify the complete
path:

```sh
holvi doctor
```

## Capabilities

An installation explicitly enables capabilities in its private config.

| Capability          | Operations                                                           |
| ------------------- | -------------------------------------------------------------------- |
| `transactions.read` | Check the connection, list transactions, and inspect one transaction |
| `attachments.write` | Attach a local file after preflight checks and verify the result     |
| `bookkeeping.read`  | Inspect accounting details, categories, and category suggestions     |
| `audit.read`        | Inspect a bounded page of recent pool activity                       |

`attachments.write` operations also require `transactions.read` because the
bridge checks attachment state immediately before and after a write.

Inspect the capabilities and operations enabled on a machine:

```sh
holvi capabilities
```

## Transaction and receipt workflow

List all transactions in a date range:

```sh
holvi transactions --from 2026-07-01 --to 2026-07-31 --json
```

Add `--missing-attachments` to return only transactions without an attachment:

```sh
holvi transactions --from 2026-07-01 --to 2026-07-31 \
  --missing-attachments --json
```

The JSON output keeps Holvi's payment UUID and direct-match debt UUID separate.
Settled transactions normally have a debt UUID. Pending payments can have `null`
until Holvi creates the debt record used for attachments.

```sh
holvi preview \
  --debt '11111111-1111-4111-8111-111111111111'
```

Run an upload without `--yes` first. This checks the transaction and local file
without changing Holvi:

```sh
holvi upload \
  --debt '11111111-1111-4111-8111-111111111111' \
  --file '/absolute/path/to/receipts/example.pdf'
```

After verifying the dry-run output, perform the upload:

```sh
holvi upload \
  --debt '11111111-1111-4111-8111-111111111111' \
  --file '/absolute/path/to/receipts/example.pdf' \
  --yes
```

The bridge reads the transaction immediately before upload and refuses to
continue if any attachment exists. After Holvi accepts the file, it reads the
transaction again and succeeds only when the attachment count is exactly one.

## Bookkeeping and audit workflow

Enable `bookkeeping.read` or `audit.read` during installation to expose their
commands. These capabilities cover the configured Holvi pool, while
`transactions.read` remains restricted to the configured payment account.

Inspect the authoritative accounting document and its active line items:

```sh
holvi bookkeeping get \
  --debt '11111111-1111-4111-8111-111111111111'
```

The result distinguishes unit prices from line totals and preserves Holvi's
decimal strings without floating-point conversion. Inactive and non-line-item
records are excluded and counted in `droppedItemCount`.

List category codes and request Holvi's ordered category suggestions for one
debt:

```sh
holvi bookkeeping categories
holvi bookkeeping suggestions \
  --debt '11111111-1111-4111-8111-111111111111'
```

Inspect up to 25 recent activity entries:

```sh
holvi audit list --limit 25
```

The audit result contains one bounded newest-first page. It omits polymorphic
details, field changes, continuation URLs, and unprojected response fields.

## Command reference

| Command                                                     | Capability                                                 | Description                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------- |
| [`install`](#holvi-install)                                 | none                                                       | Configure the account and register the extension  |
| [`skill`](#holvi-skill)                                     | none                                                       | Print or install the coding-agent skill           |
| [`capabilities`](#holvi-capabilities)                       | none                                                       | Show enabled capabilities and operations          |
| [`doctor`](#holvi-doctor)                                   | any configured capability                                  | Verify the Chrome connection and an API surface   |
| [`transactions`](#holvi-transactions)                       | `transactions.read`                                        | List payment-account transactions                 |
| [`preview`](#holvi-preview)                                 | `transactions.read`                                        | Inspect one accounting debt                       |
| [`upload`](#holvi-upload)                                   | `transactions.read`, plus `attachments.write` with `--yes` | Validate or upload one receipt                    |
| [`bookkeeping`](#holvi-bookkeeping)                         | `bookkeeping.read`                                         | Read bookkeeping details and category data        |
| [`bookkeeping get`](#holvi-bookkeeping-get)                 | `bookkeeping.read`                                         | Inspect bookkeeping details and active line items |
| [`bookkeeping categories`](#holvi-bookkeeping-categories)   | `bookkeeping.read`                                         | List bookkeeping categories                       |
| [`bookkeeping suggestions`](#holvi-bookkeeping-suggestions) | `bookkeeping.read`                                         | List suggested category codes for one debt        |
| [`audit`](#holvi-audit)                                     | `audit.read`                                               | Read recent account activity                      |
| [`audit list`](#holvi-audit-list)                           | `audit.read`                                               | List recent pool activity                         |

### `holvi install`

Writes config version 2, installs the embedded extension files, and registers
the Chrome Native Messaging host. Repeated `--capability` and `--receipt-root`
options preserve their input order and remove duplicates. A valid existing HMAC
secret is reused.

```sh
holvi install \
  --group-url URL \
  --account UUID \
  --capability CAPABILITY \
  [--capability CAPABILITY] \
  [--receipt-root /absolute/path] \
  --yes
```

| Option                    | Required | Description                                         |
| ------------------------- | -------- | --------------------------------------------------- |
| `--group-url URL`         | yes      | Full `https://account.app.holvi.com/group/.../` URL |
| `--account UUID`          | yes      | Payment account UUID used by the transaction feed   |
| `--capability CAPABILITY` | yes      | Capability to enable, repeatable                    |
| `--receipt-root PATH`     | no       | Approved absolute attachment directory, repeatable  |
| `--yes`                   | yes      | Confirm registration of the Chrome native host      |

`attachments.write` requires at least one receipt root. The command prints the
config path, stable extension ID, unpacked extension path, and native host
manifest path as JSON.

### `holvi skill`

Prints the embedded agent-facing Holvi CLI primer. This form does not read the
bridge config or connect to Chrome.

```sh
holvi skill
```

Install the primer as `SKILL.md` for detected coding agents:

```sh
holvi skill install [--agent AGENT]...
```

`--agent` accepts `claude`, `opencode`, or `codex` and is repeatable. Without an
explicit target, the command detects user-level agent directories and workspace
markers. It reports an error when no supported agent is detected. Explicit
targets install without requiring prior detection.

The user-level destinations are:

```text
~/.claude/skills/holvi/SKILL.md
~/.config/opencode/skills/holvi/SKILL.md
~/.codex/skills/holvi/SKILL.md
```

Installation creates missing skill directories and replaces the destination with
the skill embedded in the running `holvi` executable, so repeated installs are
idempotent and refresh the instructions.

### `holvi capabilities`

Prints the configured capability list and every known operation as JSON. An
operation value is `true` only when all of its required capabilities are
enabled.

```sh
holvi capabilities
```

This command reads and validates the private config but does not connect to
Chrome or Holvi.

### `holvi doctor`

Verifies config loading, Native Messaging, the configured Holvi tab, session
authentication, and one API probe selected from enabled capabilities.

```sh
holvi doctor
```

Probe priority is transactions, bookkeeping categories, then audit activity. A
write-only capability set verifies authentication and reports a null probe. The
JSON result identifies the selected `probeAction` and includes account scope and
capability metadata.

### `holvi transactions`

Lists payment-feed records from the configured payment account. The bridge reads
all bounded API pages and applies date filtering locally.

```sh
holvi transactions \
  [--from YYYY-MM-DD] \
  [--to YYYY-MM-DD] \
  [--missing-attachments] \
  [--json]
```

| Option                  | Description                                           |
| ----------------------- | ----------------------------------------------------- |
| `--from YYYY-MM-DD`     | Include transactions on or after this calendar date   |
| `--to YYYY-MM-DD`       | Include transactions on or before this calendar date  |
| `--missing-attachments` | Request only transactions without attachments         |
| `--json`                | Print the complete JSON projection instead of a table |

`--from` must be on or before `--to`. With no dates, the command lists every
transaction available within the configured page and result limits. JSON keeps
`paymentUuid` and the direct-match `debtUuid` separate.

### `holvi preview`

Reads one authoritative debt record and prints the compact projection used by
the receipt workflow.

```sh
holvi preview --debt UUID
```

The result includes the debt UUID, object code, counterparty, amount, currency,
attachment count, and bookkeeping status. `--debt` must be a UUID.

### `holvi upload`

Validates a receipt path and either prints a dry-run or uploads the file.

```sh
holvi upload --debt UUID --file /absolute/path/to/receipt.pdf [--yes]
```

| Option        | Required | Description                                   |
| ------------- | -------- | --------------------------------------------- |
| `--debt UUID` | yes      | Debt that receives the attachment             |
| `--file PATH` | yes      | Absolute path under an approved receipt root  |
| `--yes`       | no       | Perform the upload after all preflight checks |

Without `--yes`, the command reads the debt and prints `dryRun`, `transaction`,
`receipt`, and `next` fields without modifying Holvi. With `--yes`, the
extension requires zero existing attachments, uploads the file, and verifies
that the resulting attachment count is exactly one.

Accepted files are nonempty PDF, PNG, JPEG, or GIF files within the configured
size limit. Canonical path checks reject relative paths and symlink escapes.

### `holvi bookkeeping`

Groups the commands that read bookkeeping details and category data.

```sh
holvi bookkeeping <COMMAND>
```

### `holvi bookkeeping get`

Reads the authoritative accounting document for a debt and prints a strict JSON
projection.

```sh
holvi bookkeeping get --debt UUID
```

The result includes debt identity, booking and workflow metadata, attachment
count, and active line items. Each line item separates `unitPrice` from
`lineTotal`. Inactive and non-line-item records contribute to
`droppedItemCount`. The returned debt UUID must match the requested UUID.

### `holvi bookkeeping categories`

Lists the pool's bookkeeping categories as JSON.

```sh
holvi bookkeeping categories
```

Each result contains a required `code` and optional `handle` and `label`.
Unprojected category fields do not cross the extension boundary.

### `holvi bookkeeping suggestions`

Lists Holvi's ordered category suggestions for one debt.

```sh
holvi bookkeeping suggestions --debt UUID
```

The JSON result contains `debtUuid` and `categoryCodes`. Suggestion records are
normalized to category codes, bounded to 100 entries, and reject unknown item
shapes.

### `holvi audit`

Groups the commands that read recent account activity.

```sh
holvi audit <COMMAND>
```

### `holvi audit list`

Lists one bounded page of recent activity for the configured pool.

```sh
holvi audit list [--limit LIMIT]
```

`--limit` accepts values from 1 through 25 and defaults to 25. The result
contains `returnedCount`, `hasMore`, an `order` value of `newest-first`, and
scalar activity entries. The extension verifies timestamp ordering and omits the
backend continuation URL, structured content, details, summaries, and field
changes.

### Common command behavior

- `-h` and `--help` print help for the selected command.
- Successful machine-readable commands write formatted JSON to standard output.
- Human-readable transaction output uses a fixed-width table unless `--json` is
  present.
- Validation, authorization, Chrome connection, timeout, and Holvi API errors go
  to standard error and produce a nonzero exit status.
- Commands that contact Holvi require the configured signed-in group tab to
  remain open in Chrome.

## Security model

**The Holvi session stays in Chrome.** The content script reads Holvi's JWT only
when the extension service worker requests it. The token remains inside the
extension and is never sent to the native host, CLI, terminal, config file, or
attachment directory.

**The target account comes from private local config.** The native host supplies
the configured group segment, API pool handle, payment account UUID, and enabled
capabilities at runtime. The extension uses authentication only from a tab whose
full group segment matches that config.

**Capabilities are checked twice.** The native host maps every command to its
required capabilities before sending data to Chrome. The extension checks the
same boundary before calling Holvi. Unknown commands and capabilities fail
closed.

**The agent gets named operations, not an HTTP proxy.** API paths and methods
live inside the extension and cannot be supplied by the CLI caller.

**Local attachment access is allowlisted.** Files must resolve inside a
configured root. Absolute paths, canonical path containment, regular file type,
media type, readability, and size checks prevent relative path and symlink
escapes.

**Local commands are authenticated.** The installer creates a random HMAC secret
in a `0600` config file. CLI requests are signed, expire after 30 seconds, and
carry replay-protected nonces. The native host listens on a user-owned `0600`
Unix socket and accepts only the stable extension origin.

The bridge protects the boundary between Chrome, the local agent, the configured
Holvi account, and explicitly approved local files. Processes running as the
same operating-system user can already read that user's files and browser
profile.

## Local files

On macOS, files live at:

```text
~/Library/Application Support/Holvi Agent Bridge/config.json
~/Library/Application Support/Holvi Agent Bridge/extension/
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/app.holvi_agent_bridge.json
```

On Linux, equivalent files live under the XDG config directory and Google Chrome
native messaging directory.

Config format version 2 remains compatible with existing installations. Running
`holvi install` reuses a valid private HMAC secret and updates account scope,
capabilities, receipt roots, the embedded extension, and the native host
manifest.

## Native architecture

One Rust executable serves two entry paths:

- normal invocation provides the `holvi` CLI
- Chrome invocation with the allowlisted extension origin runs the Native
  Messaging host

The host owns the authenticated Unix socket, capability checks, nonce cache,
request timeout, and Native Messaging framing. Uploads use 480 KiB chunks,
SHA-256 end-to-end verification, a 25 MiB default limit, explicit confirmation,
and read-before-write and read-after-write checks in the extension.

The compiled extension files live in `assets/extension` so `cargo install` and
Nix packages can embed them. `src/extension` remains the TypeScript source of
truth. `bun run sync:artifacts` rebuilds the extension and refreshes the
embedded files. The check suite rejects differences between source builds and
embedded artifacts.

## Holvi API surfaces

The capabilities use these Holvi application endpoints:

```text
GET  /api/pool/{poolHandle}/ux/payments-feed/
GET  /api/pool/{poolHandle}/debt/{debtUuid}/
GET  /api/pool/{poolHandle}/debt/{debtUuid}/haip/bookkeeping-suggestions/
GET  /api/pool/{poolHandle}/category/
GET  /api/pool/{poolHandle}/log-feed/
POST /api/pool/{poolHandle}/attachment/formpost/
```

These are application endpoints rather than a supported public API. Holvi can
change them without notice. Keep dry runs and the check suite in the workflow
when updating the bridge.

## Development

Install extension dependencies and run the canonical check suite:

```sh
bun install --frozen-lockfile
just check
```

`just check` delegates to `checkle run all`. Checkle verifies Rust formatting,
Clippy, compilation, builds, Rust tests, extension type checking, extension
tests, linting and formatting, and embedded artifact consistency.

Useful focused commands:

```sh
checkle run rust
checkle run extension
cargo test protocol
bun run sync:artifacts
```

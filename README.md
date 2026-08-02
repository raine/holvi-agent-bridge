# Holvi Agent Bridge

`holvi-agent-bridge` gives local agents capability-scoped access to Holvi
through an existing signed-in Chrome session.

Chrome acts as the authentication vault. The agent uses a native `holvi` CLI
and does not need to navigate through the Holvi site. The bridge exposes named
operations instead of arbitrary authenticated HTTP requests, so each Holvi area
can be approved independently.

Receipt handling is the first workflow built on the bridge. It is not the
boundary of the project.

## Capabilities

An installation explicitly enables capabilities in its private config.

| Capability          | Operations                                                           |
| ------------------- | -------------------------------------------------------------------- |
| `transactions.read` | Check the connection, list transactions, and inspect one transaction |
| `attachments.write` | Attach a local file after preflight checks and verify the result     |

`attachments.write` operations also require `transactions.read` because the
bridge checks attachment state immediately before and after a write.

Inspect the capabilities and operations enabled on a machine:

```sh
holvi capabilities
```

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

## Install

Build and install the native binary:

```sh
cargo install --path . --locked
```

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
Settled transactions normally have a debt UUID. Pending payments can have
`null` until Holvi creates the debt record used for attachments.

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

On Linux, equivalent files live under the XDG config directory and Google
Chrome native messaging directory.

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
truth. `bun run sync:artifacts` rebuilds the extension and refreshes the embedded
files. The check suite rejects differences between source builds and embedded
artifacts.

## Holvi API surfaces

The capabilities use these Holvi application endpoints:

```text
GET  /api/pool/{poolHandle}/ux/payments-feed/
GET  /api/pool/{poolHandle}/debt/{debtUuid}/
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
linting and formatting, and embedded artifact consistency.

Useful focused commands:

```sh
checkle run rust
checkle run extension
cargo test protocol
bun run sync:artifacts
```

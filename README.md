# Holvi Agent Bridge

`holvi-agent-bridge` gives local agents capability-scoped access to Holvi
through an existing signed-in Chrome session.

Chrome acts as the authentication vault. The agent uses a local CLI and does
not need to navigate or click through the Holvi site. The bridge exposes named
operations instead of arbitrary authenticated HTTP requests, so each new area
of Holvi can be added and approved independently.

Receipt handling is the first workflow built on the bridge. It is not the
boundary of the project.

## Capabilities

An installation explicitly enables capabilities in its private config.

| Capability | Operations |
| --- | --- |
| `transactions.read` | Check the connection, scan transactions, and inspect one transaction |
| `attachments.write` | Attach a local file after preflight checks and verify the result |

`attachments.write` operations also require `transactions.read` because the
bridge checks attachment state immediately before and after a write.

Future capabilities can cover other Holvi areas, such as transaction metadata,
bookkeeping fields, reports, invoices, and exports. Each capability gets its
own validated commands, API implementation, and tests. The bridge has no
generic `fetch` or arbitrary endpoint command.

Inspect the capabilities and operations enabled on a machine:

```sh
holvi-agent-bridge capabilities
```

## Requirements

- macOS or Linux
- Google Chrome
- Node.js 20 or later
- a Holvi account with access to the target company
- local directories containing any files the agent may attach

## Install

Install the development dependencies and build the TypeScript source:

```sh
npm install
npm run build
npm link
```

Sign in to Holvi in Chrome. Open the company group and then its payment account
transaction feed. Copy:

- the full group URL, such as
  `https://account.app.holvi.com/group/AbC123+example-company/`
- the payment account UUID from the `payments-feed/<uuid>/` URL
- any local attachment directories the enabled capabilities may read

Register the native host with the capabilities required by the agent:

```sh
holvi-agent-bridge install \
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
holvi-agent-bridge install \
  --group-url 'https://account.app.holvi.com/group/AbC123+example-company/' \
  --account '11111111-1111-4111-8111-111111111111' \
  --capability transactions.read \
  --yes
```

The installer prints the unpacked extension path. Open `chrome://extensions`,
enable Developer mode, choose Load unpacked, and select that directory.

Confirm that Chrome shows this extension ID:

```text
oeedcemphbobfehfmcllmjhhhjgahgeb
```

The native host accepts connections from that exact extension ID. Reload the
signed-in Holvi group tab after loading the extension.

Verify the complete path from the CLI through Chrome to Holvi:

```sh
holvi-agent-bridge doctor
```

## Receipt workflow

Scan a date range for transactions that have no attachment:

```sh
holvi-agent-bridge scan --from 2026-07-01 --to 2026-07-31 --json
```

The JSON output includes each Holvi transaction UUID. Inspect the exact target
before selecting a receipt:

```sh
holvi-agent-bridge preview \
  --transaction '11111111-1111-4111-8111-111111111111'
```

Run an upload without `--yes` first. This checks the transaction and local file
without changing Holvi:

```sh
holvi-agent-bridge upload \
  --transaction '11111111-1111-4111-8111-111111111111' \
  --file '/absolute/path/to/receipts/example.pdf'
```

After verifying the dry-run output, perform the upload:

```sh
holvi-agent-bridge upload \
  --transaction '11111111-1111-4111-8111-111111111111' \
  --file '/absolute/path/to/receipts/example.pdf' \
  --yes
```

The bridge reads the transaction immediately before upload and refuses to
continue if any attachment already exists. After Holvi accepts the file, it
reads the transaction again and succeeds only when the attachment count is
exactly one.

The intended agent sequence is:

1. `scan --json`
2. match a local receipt using transaction date, merchant, amount, and currency
3. `preview`
4. `upload` as a dry run
5. `upload --yes`
6. `scan --json` again for reconciliation

## Security model

**The Holvi session stays in Chrome.** The content script reads Holvi's JWT only
when the extension service worker requests it. The token remains inside the
extension and is never sent to the native host, CLI, terminal, config file, or
attachment directory.

**The target account comes from private local config.** The extension manifest
can run on Holvi group pages, but the native host supplies the configured group
segment, API pool handle, payment account UUID, and enabled capabilities at
runtime. The extension uses authentication only from a tab whose full group
segment matches that config.

**Capabilities are checked twice.** The native host maps every command to its
required capabilities before sending data to Chrome. The extension checks the
same boundary before calling Holvi. Unknown commands and capabilities fail
closed.

**The agent gets named operations, not an HTTP proxy.** API paths and methods
live inside the extension and cannot be supplied by the CLI caller. Adding a
Holvi feature requires code that validates its input and output.

**Local attachment access is allowlisted.** Files must resolve inside a
configured root. Absolute paths, realpath containment, file type, and size
checks prevent accidental access through relative paths or symlink escapes.

**Local commands are authenticated.** The installer creates a random HMAC
secret in a `0600` config file. CLI requests are signed, expire after 30
seconds, and carry replay-protected nonces. The native host listens on a
user-owned `0600` Unix socket and accepts only the stable extension origin.

The bridge protects the boundary between Chrome, the local agent, the
configured Holvi account, and explicitly approved local files. It does not try
to defend against processes that already run as the same operating-system
user, because those processes can read the user's files and browser profile
directly.

## Local files

On macOS, configuration lives at:

```text
~/Library/Application Support/Holvi Agent Bridge/config.json
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/app.holvi_agent_bridge.json
```

On Linux, the equivalent files live under the XDG config directory and the
Google Chrome native messaging directory.

The private config contains the target account identifiers, enabled
capabilities, approved attachment roots, upload size limit, and local HMAC
secret. It does not contain Holvi credentials.

## Adding a capability

Every addition follows the same shape:

1. add a stable capability name to `SUPPORTED_CAPABILITIES`
2. map each native action to its required capabilities
3. expose a purpose-built CLI command with validated arguments
4. implement fixed Holvi API paths and methods in the extension
5. project API responses into a documented agent-facing result
6. add tests for authorization, validation, failure, and success paths

Write capabilities should include a read-before-write precondition and a
read-after-write verification whenever Holvi exposes the necessary state.

## Holvi API surfaces

The initial capabilities use these private Holvi application endpoints:

```text
GET  /api/pool/{poolHandle}/ux/payments-feed/
GET  /api/pool/{poolHandle}/debt/{transactionUuid}/
POST /api/pool/{poolHandle}/attachment/formpost/
```

These are application endpoints rather than a supported public API. Holvi can
change them without notice. Keep dry runs and the test suite in the workflow
when updating the bridge.

## Development

Run strict type checking, build the Chrome and Node.js output, and execute the
tests:

```sh
npm run check
npm test
```

Chrome loads `dist/extension`. The native host runs `dist/native/host.js`.
TypeScript source lives under `src/`.

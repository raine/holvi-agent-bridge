# Holvi CLI Primer

`holvi` gives local agents capability-scoped access to one configured Holvi
account through an existing signed-in Chrome session. Use named CLI operations
for Holvi work. Authentication stays inside Chrome.

## Start here

- Run `holvi capabilities` before choosing a workflow. It shows the configured
  capabilities and the operations each one enables without contacting Holvi.
- Keep the configured Holvi group open and signed in in Chrome. Run
  `holvi doctor` when the connection, account scope, or session is unclear.
- Run `holvi <command> --help` when you need flags not shown here.
- Human-readable output is the default for `capabilities`, `doctor`, and a
  successful `install`. Use `--json` when a structured result is required.
- Do not run `holvi install` or change capabilities, account scope, or receipt
  roots unless the user explicitly asks for that configuration change.

## Capabilities and scope

- `transactions.read` permits transaction listing and debt preview for the
  configured payment account.
- `attachments.write` combines with `transactions.read` to permit a confirmed
  receipt upload. A dry run needs only `transactions.read`.
- `bookkeeping.read` permits bookkeeping detail, category, and suggestion reads
  for the configured Holvi pool.
- `audit.read` permits one bounded recent-activity read for the configured pool.
- A command fails closed when its capability is absent. Do not work around a
  missing capability through browser automation, direct API calls, or another
  credential path.

## Transaction identifiers

- Transaction JSON keeps `paymentUuid` and `debtUuid` separate.
- Use `debtUuid` with `preview`, `upload`, `bookkeeping get`, and
  `bookkeeping suggestions`. Never substitute `paymentUuid`.
- A pending payment can have a null `debtUuid`. Wait until Holvi creates the
  debt record instead of guessing or deriving an identifier.
- Transaction scope is one configured payment account. Bookkeeping and audit
  reads have pool scope.

## Read workflows

```sh
holvi transactions --json
holvi transactions --from 2026-07-01 --to 2026-07-31 --json
holvi transactions --missing-attachments --json
holvi preview --debt 11111111-1111-4111-8111-111111111111
holvi bookkeeping get --debt 11111111-1111-4111-8111-111111111111
holvi bookkeeping categories
holvi bookkeeping suggestions \
  --debt 11111111-1111-4111-8111-111111111111
holvi audit list --limit 25
```

- Prefer `transactions --json` when matching records or passing identifiers to a
  later command. Without `--json`, transactions use a human-readable table.
- `--from` and `--to` are inclusive `YYYY-MM-DD` calendar dates. With no dates,
  `transactions` returns all records available within bridge limits.
- Bookkeeping detail keeps decimal values as strings and separates `unitPrice`
  from `lineTotal`. Do not perform money calculations with binary floating
  point.
- Audit output is a bounded newest-first scalar projection. It intentionally
  omits backend continuation URLs and unprojected detail.

## Receipt workflow

A receipt upload is a write. Always use this sequence:

1. Confirm that the user wants the specific file attached to the specific debt.
2. Run the command without `--yes` for a dry run:

   ```sh
   holvi upload \
     --debt 11111111-1111-4111-8111-111111111111 \
     --file /absolute/path/to/receipt.pdf
   ```

3. Inspect the returned transaction, canonical receipt path, media type, size,
   and next-action text. Resolve any mismatch instead of proceeding.
4. Add `--yes` only with explicit authorization for that upload:

   ```sh
   holvi upload \
     --debt 11111111-1111-4111-8111-111111111111 \
     --file /absolute/path/to/receipt.pdf \
     --yes
   ```

- Treat `--yes` as authorization to mutate Holvi, not as a convenience flag.
- Never broaden a receipt root, replace a file, follow a symlink escape, or copy
  sensitive data into an approved root to bypass a path rejection.
- Accepted files are nonempty PDF, PNG, JPEG, or GIF files under an approved
  canonical receipt root and within the configured size limit.
- The bridge refuses a write when the debt already has an attachment. It reads
  before the upload and succeeds only after a read verifies exactly one
  attachment.
- Report the verified result. Do not claim success from the initial upload
  response alone.

## Installation workflow

Use installation only when the user asks to configure or reconfigure the bridge:

```sh
holvi install \
  --group-url 'https://account.app.holvi.com/group/AbC123+example-company/' \
  --account 11111111-1111-4111-8111-111111111111 \
  --capability transactions.read \
  --receipt-root /absolute/path/to/receipts \
  --yes
```

- Repeat `--capability` and `--receipt-root` for each approved value.
- `--yes` confirms native-host registration. It is required for installation.
- `attachments.write` requires at least one receipt root.
- Installation updates the private account scope and capability allowlist. Show
  the proposed scope to the user before running it.

## Security boundary and errors

- The CLI never needs a Holvi password, JWT, cookie, or CSRF token. Do not ask
  the user to expose one or place one in files, shell arguments, logs, or
  messages.
- The bridge exposes named operations, not arbitrary authenticated HTTP fetches.
  Do not attempt to turn it into a generic API proxy.
- Keep request sizes and result limits bounded. Use command filters rather than
  scraping unrelated Holvi surfaces.
- A missing-socket error means the configured signed-in group tab must be opened
  or reloaded in Chrome. Run `holvi doctor` after restoring the tab.
- Capability, ownership, permission, path, timeout, projection, and API errors
  are security or integrity checks. Surface the error and correct the stated
  input or environment. Do not bypass the check.

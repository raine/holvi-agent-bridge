import { maxDebtAttachments, projectUploadDebtRead } from "./projections.js";
import type { Auth } from "./background-types.js";
import { HolviApi } from "./holvi-api.js";
import { BridgeSession, validateUuid } from "./session.js";
import {
  type UploadTransfer,
  verifyUploadTransfer,
} from "./upload-transfer.js";

type JsonRecord = Record<string, unknown>;

function projectedAttachments(debt: JsonRecord): JsonRecord[] {
  if (!Array.isArray(debt.attachments)) {
    throw new Error("Projected upload debt has an invalid attachment list.");
  }
  return debt.attachments.map((attachment) => attachment as JsonRecord);
}

function attachmentCode(attachment: JsonRecord): string {
  if (
    typeof attachment.attachmentCode !== "string" ||
    !attachment.attachmentCode
  ) {
    throw new Error("Projected upload attachment has an invalid code.");
  }
  return attachment.attachmentCode;
}

function verifyAdditiveUpload(
  before: JsonRecord[],
  after: JsonRecord[],
): JsonRecord {
  const expectedCount = before.length + 1;
  if (after.length !== expectedCount) {
    throw new Error(
      `Holvi accepted the upload but verification expected ${expectedCount} attachment(s) and found ${after.length}. Inspect the transaction before retrying.`,
    );
  }

  const existing = new Map(
    before.map((attachment) => [attachmentCode(attachment), attachment]),
  );
  for (const [code, expected] of existing) {
    const actual = after.find(
      (attachment) => attachmentCode(attachment) === code,
    );
    if (!actual) {
      throw new Error(
        "Holvi accepted the upload but verification found a missing existing attachment. Inspect the transaction before retrying.",
      );
    }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        "Holvi accepted the upload but verification found a changed existing attachment. Inspect the transaction before retrying.",
      );
    }
  }

  const added = after.filter(
    (attachment) => !existing.has(attachmentCode(attachment)),
  );
  if (added.length !== 1) {
    throw new Error(
      `Holvi accepted the upload but verification found ${added.length} new attachment(s). Inspect the transaction before retrying.`,
    );
  }
  return added[0]!;
}

export class UploadWorkflow {
  constructor(
    private readonly session: BridgeSession,
    private readonly api: HolviApi,
    private readonly sleep: (delay: number) => Promise<void> = (delay) =>
      new Promise((resolve) => self.setTimeout(resolve, delay)),
  ) {}

  async uploadReceipt(
    auth: Auth,
    upload: UploadTransfer,
  ): Promise<Record<string, unknown>> {
    this.session.requireCapabilities("transactions.read", "attachments.write");
    const debtUuid = validateUuid(upload.debtUuid, "debt");
    const before = projectUploadDebtRead(
      await this.api.request(auth, this.api.debtPath(debtUuid)),
      debtUuid,
      this.session.config.paymentAccountUuid,
    );
    const beforeAttachments = projectedAttachments(before);
    const beforeCount = beforeAttachments.length;
    if (beforeCount >= maxDebtAttachments) {
      throw new Error(
        `Upload refused because the transaction has reached the ${maxDebtAttachments}-attachment verification limit.`,
      );
    }
    if (typeof before.code !== "string" || !before.code) {
      throw new Error(
        "Holvi did not return the object code required for upload.",
      );
    }

    const bytes = await verifyUploadTransfer(upload);

    const form = new FormData();
    form.append("content_type", "debt");
    form.append("object_code", before.code);
    form.append(
      "attachment_file",
      new File([bytes], upload.fileName, { type: upload.mimeType }),
    );

    await this.api.request(
      auth,
      `${this.session.apiRoot()}attachment/formpost/`,
      {
        method: "POST",
        body: form,
      },
    );

    let afterAttachments = beforeAttachments;
    for (const delay of [0, 250, 500, 1000, 2000]) {
      if (delay) {
        await this.sleep(delay);
      }
      const after = projectUploadDebtRead(
        await this.api.request(auth, this.api.debtPath(debtUuid)),
        debtUuid,
        this.session.config.paymentAccountUuid,
      );
      afterAttachments = projectedAttachments(after);
      if (afterAttachments.length > beforeCount) {
        break;
      }
    }

    const attachment = verifyAdditiveUpload(
      beforeAttachments,
      afterAttachments,
    );
    return {
      debtUuid,
      fileName: upload.fileName,
      sha256: upload.sha256,
      attachmentCountBefore: beforeCount,
      attachmentCountAfter: afterAttachments.length,
      attachment,
    };
  }
}

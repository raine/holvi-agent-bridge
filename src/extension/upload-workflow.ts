import { projectUploadDebtRead } from "./projections.js";
import type { Auth } from "./background-types.js";
import { HolviApi } from "./holvi-api.js";
import { BridgeSession, validateUuid } from "./session.js";
import {
  type UploadTransfer,
  verifyUploadTransfer,
} from "./upload-transfer.js";

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
    const beforeCount = before.attachmentCount as number;
    if (beforeCount !== 0) {
      throw new Error(
        `Upload refused because the transaction has ${beforeCount} attachment(s).`,
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

    let afterCount = 0;
    for (const delay of [0, 250, 500, 1000, 2000]) {
      if (delay) {
        await this.sleep(delay);
      }
      const after = projectUploadDebtRead(
        await this.api.request(auth, this.api.debtPath(debtUuid)),
        debtUuid,
        this.session.config.paymentAccountUuid,
      );
      afterCount = after.attachmentCount as number;
      if (afterCount > 0) {
        break;
      }
    }

    if (afterCount !== 1) {
      throw new Error(
        `Holvi accepted the upload but verification found ${afterCount} attachment(s). Inspect the transaction before retrying.`,
      );
    }

    return {
      debtUuid,
      fileName: upload.fileName,
      sha256: upload.sha256,
      attachmentCountBefore: beforeCount,
      attachmentCountAfter: afterCount,
    };
  }
}

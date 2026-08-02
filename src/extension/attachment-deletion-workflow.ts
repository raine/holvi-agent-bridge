import type { Auth } from "./background-types.js";
import { HolviApi } from "./holvi-api.js";
import { projectAttachmentDeletionDebt } from "./projections.js";
import { BridgeSession, validateUuid } from "./session.js";

type ProjectedAttachment = {
  attachmentCode: string;
  title: string;
  format: string | null;
};

function validateAttachmentCode(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    Array.from({ length: value.length }, (_, index) =>
      value.charCodeAt(index),
    ).some((code) => code < 32 || code === 127)
  ) {
    throw new Error("Attachment code must be a nonempty bounded string.");
  }
  return value;
}

function attachments(debt: Record<string, unknown>): ProjectedAttachment[] {
  if (!Array.isArray(debt.attachments)) {
    throw new Error("Holvi attachment deletion projection is invalid.");
  }
  return debt.attachments as ProjectedAttachment[];
}

function sameRemainingAttachments(
  before: ProjectedAttachment[],
  after: ProjectedAttachment[],
  deletedCode: string,
): boolean {
  const expected = before.filter(
    (attachment) => attachment.attachmentCode !== deletedCode,
  );
  if (after.length !== expected.length) {
    return false;
  }
  const actualByCode = new Map(
    after.map((attachment) => [attachment.attachmentCode, attachment]),
  );
  return expected.every((attachment) => {
    const actual = actualByCode.get(attachment.attachmentCode);
    return actual && JSON.stringify(actual) === JSON.stringify(attachment);
  });
}

export class AttachmentDeletionWorkflow {
  constructor(
    private readonly session: BridgeSession,
    private readonly api: HolviApi,
    private readonly sleep: (delay: number) => Promise<void> = (delay) =>
      new Promise((resolve) => self.setTimeout(resolve, delay)),
  ) {}

  async deleteAttachment(
    auth: Auth,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.session.requireCapabilities("transactions.read", "attachments.delete");
    const debtUuid = validateUuid(
      typeof params.debtUuid === "string" ? params.debtUuid : "",
      "debt",
    );
    const attachmentCode = validateAttachmentCode(params.attachmentCode);
    if (typeof params.confirmed !== "boolean") {
      throw new Error("Attachment deletion confirmation is invalid.");
    }

    const before = projectAttachmentDeletionDebt(
      await this.api.request(auth, this.api.debtPath(debtUuid)),
      debtUuid,
      this.session.config.paymentAccountUuid,
    );
    const beforeAttachments = attachments(before);
    const matches = beforeAttachments.filter(
      (attachment) => attachment.attachmentCode === attachmentCode,
    );
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? "Attachment deletion target does not exist on the selected debt."
          : "Attachment deletion target is ambiguous on the selected debt.",
      );
    }
    const target = matches[0];

    if (!params.confirmed) {
      return {
        dryRun: true,
        debt: before,
        attachment: target,
        next: "Repeat the attachment deletion command with --yes after checking these values.",
      };
    }

    await this.api.request(
      auth,
      `${this.session.apiRoot()}attachment/${encodeURIComponent(attachmentCode)}/`,
      { method: "DELETE" },
    );

    let after: Record<string, unknown> | null = null;
    for (const delay of [0, 250, 500, 1000, 2000]) {
      if (delay) {
        await this.sleep(delay);
      }
      after = projectAttachmentDeletionDebt(
        await this.api.request(auth, this.api.debtPath(debtUuid)),
        debtUuid,
        this.session.config.paymentAccountUuid,
      );
      if (
        sameRemainingAttachments(
          beforeAttachments,
          attachments(after),
          attachmentCode,
        )
      ) {
        return {
          dryRun: false,
          debtUuid,
          attachment: target,
          attachmentCountBefore: beforeAttachments.length,
          attachmentCountAfter: attachments(after).length,
          verified: true,
        };
      }
    }

    throw new Error(
      "Holvi accepted the deletion but the resulting attachment state could not be verified. Inspect the debt before retrying.",
    );
  }
}

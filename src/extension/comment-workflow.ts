import type { Auth } from "./background-types.js";
import { HolviApi, maxCommentResponseBytes } from "./holvi-api.js";
import {
  maxCommentContentBytes,
  projectCommentWriteResponse,
} from "./projections.js";
import { BridgeSession, validateUuid } from "./session.js";

function validateCommentContent(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).byteLength > maxCommentContentBytes
  ) {
    throw new Error(
      `Comment content must contain text and fit within ${maxCommentContentBytes} UTF-8 bytes.`,
    );
  }
  return value;
}

function sameCommentWithoutUuid(
  candidate: Record<string, unknown>,
  expected: Record<string, unknown>,
): boolean {
  return (
    candidate.content === expected.content &&
    candidate.createTime === expected.createTime &&
    candidate.pushNotified === expected.pushNotified &&
    JSON.stringify(candidate.creator) === JSON.stringify(expected.creator)
  );
}

export class CommentWorkflow {
  constructor(
    private readonly session: BridgeSession,
    private readonly api: HolviApi,
  ) {}

  async createComment(
    auth: Auth,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    this.session.requireCapabilities("transactions.read", "comments.write");
    if (params.confirmed !== true) {
      throw new Error("Comment creation requires explicit confirmation.");
    }
    const debtUuid = validateUuid(
      typeof params.debtUuid === "string" ? params.debtUuid : "",
      "debt",
    ).toLowerCase();
    const content = validateCommentContent(params.content);

    await this.api.previewDebt(auth, debtUuid);
    const created = projectCommentWriteResponse(
      await this.api.request(
        auth,
        this.api.commentPath(debtUuid),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content, notify_push: false }),
        },
        maxCommentResponseBytes,
      ),
    );
    if (created.content !== content || created.pushNotified !== false) {
      throw new Error(
        "Holvi comment creation response did not match the requested content and notification state.",
      );
    }

    const listing = await this.api.listComments(auth, debtUuid);
    const comments = listing.results as Record<string, unknown>[];
    const createdUuid = created.uuid;
    const matches =
      typeof createdUuid === "string"
        ? comments.filter(
            (comment) =>
              typeof comment.uuid === "string" &&
              comment.uuid.toLowerCase() === createdUuid.toLowerCase(),
          )
        : comments.filter((comment) =>
            sameCommentWithoutUuid(comment, created),
          );
    if (matches.length !== 1) {
      throw new Error(
        "Holvi accepted the comment but an authoritative read could not identify exactly one matching record. Inspect the transaction before retrying.",
      );
    }
    const verified = matches[0]!;
    if (verified.content !== content || verified.pushNotified !== false) {
      throw new Error(
        "Holvi accepted the comment but verification found different content or notification state. Inspect the transaction before retrying.",
      );
    }

    return { debtUuid, comment: verified };
  }
}

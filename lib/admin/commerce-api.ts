import { actionError } from "./action-messages";
import type { CommerceError } from "./commerce";
import { contentError } from "./content-api";

/** Fields that are shown but never edited here; a request that sends one is refused (400), not silently ignored. */
const READ_ONLY = new Set(["usedCount", "smRatePlanCode", "sinopacMerchantId", "smPropertyCode"]);

/** The admin API's answer to a failed commerce write. */
export function commerceError(r: CommerceError): Response {
  if (r.error === "INVALID_INPUT" && READ_ONLY.has(r.field)) return actionError("READ_ONLY_FIELD", undefined, { field: r.field });
  return r.error === "CODE_TAKEN" ? actionError("CODE_TAKEN") : contentError(r as Parameters<typeof contentError>[0]);
}

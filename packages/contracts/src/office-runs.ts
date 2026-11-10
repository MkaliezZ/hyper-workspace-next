import { z } from "zod";
import { FilePath, OfficeSource } from "./index.js";
import { OfficeOperations, OfficeSha256 } from "./office.js";

export const OfficeRunPlan = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("draft"),
      source: OfficeSource,
      expectedSha256: OfficeSha256,
      destination: FilePath.max(19),
      instruction: z.string().trim().min(1).max(4000),
    })
    .strict(),
  z
    .object({
      operation: z.literal("apply"),
      proposalId: z.uuid(),
      expectedRevision: z.number().int().min(1).max(2147483646),
      confirmed: z.literal(true),
    })
    .strict(),
]);
export type OfficeRunPlan = z.infer<typeof OfficeRunPlan>;
export const OfficeRunInput = z
  .object({
    plan: OfficeRunPlan,
    engine: z.enum(["dsh", "hermes"]).default("dsh"),
    modelProfileId: z.uuid(),
    idempotencyKey: z.uuid(),
  })
  .strict();
export type OfficeRunInput = z.infer<typeof OfficeRunInput>;
export const OfficeDraftAction = z
  .object({ operations: OfficeOperations })
  .strict();
export const isOfficeWorkflow = (workflow: string) =>
  workflow === "draft_office" || workflow === "apply_office";

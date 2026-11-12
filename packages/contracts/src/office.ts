import { z } from "zod";
import {
  FilePath,
  OfficeSource,
  type OfficeFormat,
  type SourceFile,
} from "./index.js";

export const OfficeSha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const OfficeFormatSchema = z.enum(["docx", "xlsx", "pptx"]);
const text = z.string().max(4000);
const revision = z.number().int().min(1).max(2147483646);
export const OfficeCellValue = z.discriminatedUnion("type", [
  z.object({ type: z.literal("empty"), value: z.null() }).strict(),
  z.object({ type: z.literal("string"), value: text }).strict(),
  z.object({ type: z.literal("number"), value: z.number().finite() }).strict(),
  z
    .object({ type: z.literal("formula"), value: text.min(1).startsWith("=") })
    .strict(),
]);
export const OfficeOperation = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("writer.append"),
      target: z.literal("document:end"),
      text,
    })
    .strict(),
  z
    .object({
      kind: z.literal("writer.replace"),
      target: z.string().regex(/^paragraph:(0|[1-9]\d{0,2})$/),
      expectedText: text,
      text,
    })
    .strict(),
  z
    .object({
      kind: z.literal("calc.set"),
      sheet: z.string().regex(/^sheet:([0-9]|1[0-5])$/),
      cell: z.string().regex(/^(?:[A-Z]|A[A-Z]|B[A-L])(?:[1-9]\d{0,2}|1000)$/),
      expected: OfficeCellValue,
      value: OfficeCellValue,
    })
    .strict(),
  z
    .object({
      kind: z.literal("impress.replace"),
      target: z.string().regex(/^slide:(0|[1-9]\d?)\/shape:(0|[1-9]\d{0,2})$/),
      expectedText: text,
      text,
    })
    .strict(),
]);
export type OfficeOperation = z.infer<typeof OfficeOperation>;
export const OfficeOperations = z
  .array(OfficeOperation)
  .min(1)
  .max(32)
  .superRefine((ops, ctx) => {
    const targets = new Set<string>();
    ops.forEach((op, index) => {
      const target =
        op.kind === "calc.set" ? op.sheet + "/" + op.cell : op.target;
      if (targets.has(target))
        ctx.addIssue({
          code: "custom",
          path: [index],
          message: "同一目标只能修改一次。",
        });
      targets.add(target);
    });
  });

export const OfficeInspection = z
  .union([
    z
      .object({
        paragraphs: z
          .array(
            z
              .object({
                id: z.string().regex(/^paragraph:\d+$/),
                text,
                editable: z.boolean(),
              })
              .strict(),
          )
          .max(1000),
        appendTarget: z.literal("document:end"),
      })
      .strict(),
    z
      .object({
        sheets: z
          .array(
            z
              .object({
                id: z.string().regex(/^sheet:\d+$/),
                name: z.string().max(255),
                rows: z.number().int().min(1).max(1000),
                columns: z.number().int().min(1).max(64),
                cells: z
                  .array(
                    z
                      .object({
                        address: z.string().max(6),
                        type: z.enum(["empty", "string", "number", "formula"]),
                        value: z.union([z.null(), text, z.number().finite()]),
                        display: text,
                        error: z.number().int().min(0),
                        editable: z.boolean(),
                      })
                      .strict(),
                  )
                  .max(2000),
              })
              .strict(),
          )
          .max(16),
      })
      .strict(),
    z
      .object({
        slides: z
          .array(
            z
              .object({
                id: z.string().regex(/^slide:\d+$/),
                shapes: z
                  .array(
                    z
                      .object({
                        id: z.string().regex(/^slide:\d+\/shape:\d+$/),
                        text,
                        editable: z.boolean(),
                      })
                      .strict(),
                  )
                  .max(1000),
              })
              .strict(),
          )
          .max(100),
      })
      .strict(),
  ])
  .superRefine((inspection, context) => {
    let characters = 0;
    if ("paragraphs" in inspection) {
      characters = inspection.paragraphs.reduce(
        (sum, paragraph) => sum + paragraph.text.length,
        0,
      );
    } else if ("sheets" in inspection) {
      const cells = inspection.sheets.flatMap((sheet) => sheet.cells);
      if (cells.length > 2000)
        context.addIssue({
          code: "custom",
          message: "Office 单元格超过检查上限。",
        });
      characters = cells.reduce(
        (sum, cell) =>
          sum +
          cell.display.length +
          (typeof cell.value === "string" ? cell.value.length : 0),
        0,
      );
    } else {
      const shapes = inspection.slides.flatMap((slide) => slide.shapes);
      if (shapes.length > 1000)
        context.addIssue({
          code: "custom",
          message: "Office shape 超过检查上限。",
        });
      characters = shapes.reduce((sum, shape) => sum + shape.text.length, 0);
    }
    if (characters > 200000)
      context.addIssue({
        code: "custom",
        message: "Office 预览超过字符上限。",
      });
  });
export type OfficeInspection = z.infer<typeof OfficeInspection>;
export const OfficePreview = z
  .object({
    operations: z
      .array(
        z
          .object({
            kind: z.enum([
              "writer.append",
              "writer.replace",
              "calc.set",
              "impress.replace",
            ]),
            target: z.string().max(100),
            before: z.union([z.null(), text, OfficeCellValue]),
            after: z.union([text, OfficeCellValue]),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    recalculated: z.boolean(),
    formulaErrors: z
      .array(
        z
          .object({
            sheet: z.string().max(100),
            cell: z.string().max(6),
            error: z.number().int().min(1),
          })
          .strict(),
      )
      .max(2000),
    reopenedVerified: z.literal(true),
  })
  .strict();
export type OfficePreview = z.infer<typeof OfficePreview>;

export const OfficeProposalCreate = z
  .object({
    source: OfficeSource,
    expectedSha256: OfficeSha256,
    operations: OfficeOperations,
    destination: FilePath.max(19),
    idempotencyKey: z.uuid(),
  })
  .strict();
export type OfficeProposalCreate = z.infer<typeof OfficeProposalCreate>;
export const OfficeProposalEdit = z
  .object({
    expectedRevision: revision,
    operations: OfficeOperations,
    idempotencyKey: z.uuid(),
  })
  .strict();
export type OfficeProposalEdit = z.infer<typeof OfficeProposalEdit>;
export const OfficeProposalApply = z
  .object({
    confirmed: z.literal(true),
    expectedRevision: revision,
    idempotencyKey: z.uuid(),
  })
  .strict();
export type OfficeProposalApply = z.infer<typeof OfficeProposalApply>;
export const OfficeProposalCancel = OfficeProposalApply.omit({
  confirmed: true,
});
export type OfficeProposalCancel = z.infer<typeof OfficeProposalCancel>;

export interface OfficeInspectionResult {
  source: OfficeSource;
  binding: string;
  format: OfficeFormat;
  sourceSha256: string;
  engine: string;
  inspection: OfficeInspection;
}
export interface OfficeProposalResult {
  id: string;
  revision: number;
  state:
    | "prepared"
    | "processing"
    | "applying"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "recovery_required";
  sourceStatus: "current" | "invalidated";
  source: OfficeSource | null;
  sourceSha256: string;
  format: OfficeFormat;
  title: string | null;
  destination: string[] | null;
  targetPath: string[] | null;
  operations: OfficeOperation[] | null;
  preview: OfficePreview | null;
  engine: string;
  error: string | null;
  retryable: boolean;
  cancelRequested: boolean;
  outputSha256: string | null;
  file: SourceFile | null;
  sourceRunId: string | null;
  applyRunId: string | null;
  createdAt: string;
  updatedAt: string;
}

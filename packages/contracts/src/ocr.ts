import { z } from "zod";
import { FilePath } from "./index.js";

export const OcrSource = z
  .object({
    path: FilePath.min(1),
    expectedId: z.string().regex(/^[1-9]\d{0,19}$/),
    expectedEtag: z.string().min(1).max(256),
    page: z.number().int().min(1).max(50),
  })
  .strict();
export type OcrSource = z.infer<typeof OcrSource>;

const revision = z.number().int().min(0).max(2147483646);
export const OcrRecognition = z
  .object({
    source: OcrSource,
    expectedRevision: revision,
    idempotencyKey: z.uuid(),
  })
  .strict();
export type OcrRecognition = z.infer<typeof OcrRecognition>;

const text = z.string().max(12000);
export const OcrCorrection = z
  .object({
    expectedRevision: revision.min(1),
    texts: z.array(text).min(1).max(300),
    idempotencyKey: z.uuid(),
  })
  .strict();
export type OcrCorrection = z.infer<typeof OcrCorrection>;

export const OcrPage = z
  .object({
    width: z.number().int().positive().max(20000),
    height: z.number().int().positive().max(20000),
    blocks: z
      .array(
        z
          .object({
            kind: z.enum(["title", "text", "table", "other"]),
            bounds: z.tuple([
              z.number().finite().min(0),
              z.number().finite().min(0),
              z.number().finite().min(0),
              z.number().finite().min(0),
            ]),
            confidence: z.number().min(0).max(1).nullable(),
            text,
          })
          .strict(),
      )
      .max(300),
  })
  .strict()
  .superRefine((value, context) => {
    let length = 0;
    for (const [index, block] of value.blocks.entries()) {
      const [left, top, right, bottom] = block.bounds;
      if (
        right <= left ||
        bottom <= top ||
        right > value.width ||
        bottom > value.height
      )
        context.addIssue({
          code: "custom",
          path: ["blocks", index, "bounds"],
          message: "OCR 坐标超出页面范围。",
        });
      length += block.text.length;
    }
    if (length > 120000)
      context.addIssue({
        code: "custom",
        path: ["blocks"],
        message: "OCR 文本超过页限额。",
      });
  });
export type OcrPage = z.infer<typeof OcrPage>;

export interface OcrResult {
  id: string;
  source: OcrSource;
  title: string;
  revision: number;
  confirmedRevision: number | null;
  state: "draft" | "confirmed";
  engine: string;
  recordedAt: string;
  content: OcrPage;
}

const sourceMime: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

export function supportsOcr(file: {
  kind: string;
  size: number;
  name: string;
  mime: string;
}) {
  const extension = file.name.toLowerCase().split(".").at(-1);
  return (
    file.kind === "file" &&
    file.size > 0 &&
    file.size <= 8 * 1024 * 1024 &&
    extension !== undefined &&
    sourceMime[extension] === file.mime
  );
}

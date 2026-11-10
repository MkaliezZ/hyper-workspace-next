import type { Subject } from "@hyper/contracts";
import type { Database } from "../db/database.js";
import { OcrService } from "./ocr.js";
import { SourceFileService } from "./source-files.js";

/** Product assets whose read/index use still requires current upstream authorization. */
export async function verifyKnowledgeSources(
  db: Database,
  s: Subject,
  ids?: string[],
) {
  const [files, ocr] = await Promise.all([
    new SourceFileService(db).verify(s, ids),
    new OcrService(db).verifyAssets(s, ids),
  ]);
  return new Map([...files.allowed, ...ocr]);
}

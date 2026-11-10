import { createHash } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { z } from "zod";
import {
  OfficeFormatSchema,
  OfficeInspection,
  OfficeOperations,
  OfficePreview,
  OfficeSha256,
  type OfficeOperation,
} from "@hyper/contracts/office";
import type { OfficeFormat } from "@hyper/contracts";
import { ocrEndpoint } from "./ocr-provider.js";

export const officeDigest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const envelope = z.object({
  protocol: z.literal("office-batch/v1"),
  engine: z.literal("collabora-26.04.6.1/pyuno-26.04.6-1"),
  format: OfficeFormatSchema,
  sourceSha256: OfficeSha256,
});
const inspected = envelope.extend({ inspection: OfficeInspection }).strict();
const transformed = envelope
  .extend({
    contentBase64: z.string().max(11184812),
    outputSha256: OfficeSha256,
    summary: OfficePreview,
  })
  .strict();
const maxBytes = 8 * 1024 * 1024;
/** Fixed internal runtime only. No employee URL, credentials, paths or executable code cross this boundary. */
export class OfficeProvider {
  private async request(
    route: string,
    input: { bytes: Buffer; format: OfficeFormat; signal?: AbortSignal },
    operations?: OfficeOperation[],
  ) {
    if (!input.bytes.length || input.bytes.length > maxBytes)
      throw new BadRequestException("Office 文件超出大小限制。");
    let base: URL | undefined;
    try {
      base = ocrEndpoint(process.env.HYPER_OFFICE_BATCH_URL);
    } catch {
      throw new ServiceUnavailableException(
        "Office 批处理服务须使用内网地址。",
      );
    }
    if (!base || !["", "/"].includes(base.pathname))
      throw new ServiceUnavailableException(
        "管理员尚未配置内网 Office 批处理服务。",
      );
    const body = JSON.stringify({
      format: input.format,
      contentBase64: input.bytes.toString("base64"),
      ...(operations
        ? {
            sourceSha256: officeDigest(input.bytes),
            operations: OfficeOperations.parse(operations),
          }
        : {}),
    });
    try {
      const response = await fetch(new URL(route, base), {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
        },
        redirect: "error",
        signal: AbortSignal.any([
          AbortSignal.timeout(75000),
          ...(input.signal ? [input.signal] : []),
        ]),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if ([400, 413, 422].includes(response.status))
          throw new BadRequestException(
            "Office 文件或操作不符合受限编辑规则。",
          );
        if (response.status === 409)
          throw new ConflictException("Office 来源或预期内容已变化。");
        throw new Error("office unavailable");
      }
      if (
        !response.headers.get("content-type")?.startsWith("application/json") ||
        Number(response.headers.get("content-length")) > 12 * 1024 * 1024
      ) {
        await response.body?.cancel();
        throw new Error("office response invalid");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("office response missing");
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.length;
          if (size > 12 * 1024 * 1024)
            throw new Error("office response oversized");
          chunks.push(next.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) {
      input.signal?.throwIfAborted();
      if (
        error instanceof BadRequestException ||
        error instanceof ConflictException
      )
        throw error;
      throw new ServiceUnavailableException(
        "Office 引擎暂未返回可验证的结果。",
      );
    }
  }
  async inspect(input: {
    bytes: Buffer;
    format: OfficeFormat;
    signal?: AbortSignal;
  }) {
    const value = inspected.safeParse(await this.request("/inspect", input));
    if (
      !value.success ||
      value.data.sourceSha256 !== officeDigest(input.bytes) ||
      value.data.format !== input.format ||
      JSON.stringify(value.data.inspection).length > 1024 * 1024 ||
      (input.format === "docx" && !("paragraphs" in value.data.inspection)) ||
      (input.format === "xlsx" && !("sheets" in value.data.inspection)) ||
      (input.format === "pptx" && !("slides" in value.data.inspection))
    )
      throw new ServiceUnavailableException("Office 检查结果无法验证。");
    return value.data;
  }
  async transform(input: {
    bytes: Buffer;
    format: OfficeFormat;
    operations: OfficeOperation[];
    signal?: AbortSignal;
  }) {
    const value = transformed.safeParse(
      await this.request("/transform", input, input.operations),
    );
    if (
      !value.success ||
      value.data.sourceSha256 !== officeDigest(input.bytes) ||
      value.data.format !== input.format
    )
      throw new ServiceUnavailableException("Office 生成结果无法验证。");
    const result = value.data,
      bytes = Buffer.from(result.contentBase64, "base64");
    if (
      !bytes.length ||
      bytes.length > maxBytes ||
      bytes.toString("base64") !== result.contentBase64 ||
      officeDigest(bytes) !== result.outputSha256 ||
      result.summary.operations.length !== input.operations.length
    )
      throw new ServiceUnavailableException("Office 新副本校验失败。");
    if (
      result.summary.recalculated !== (input.format === "xlsx") ||
      !input.operations.every((op, index) => {
        const observed = result.summary.operations[index]!;
        if (observed.kind !== op.kind) return false;
        if (op.kind === "writer.append")
          return (
            /^paragraph:\d+$/.test(observed.target) &&
            observed.before === null &&
            observed.after === op.text
          );
        if (op.kind === "calc.set")
          return (
            observed.target === op.sheet + "/" + op.cell &&
            JSON.stringify(observed.before) === JSON.stringify(op.expected) &&
            typeof observed.after === "object" &&
            observed.after.type === op.value.type &&
            (op.value.type === "formula" ||
              JSON.stringify(observed.after) === JSON.stringify(op.value))
          );
        return (
          observed.target === op.target &&
          observed.before === op.expectedText &&
          observed.after === op.text
        );
      })
    )
      throw new ServiceUnavailableException("Office 回读摘要与确认操作不符。");
    return {
      engine: result.engine,
      bytes,
      outputSha256: result.outputSha256,
      preview: result.summary,
    };
  }
}

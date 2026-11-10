import { isIP } from "node:net";
import {
  BadRequestException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { OcrPage } from "@hyper/contracts/ocr";

const maxResponseBytes = 1024 * 1024;
let inFlight = 0;

/** The deployment operator sets one internal endpoint. No URL comes from an employee or model. */
export function ocrEndpoint(value = process.env.HYPER_OCR_URL) {
  if (!value) return;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ServiceUnavailableException("内网 OCR 服务地址无效。");
  }
  const hostname = url.hostname;
  const [first, second] = hostname.split(".").map(Number);
  const privateIpv4 =
    isIP(hostname) === 4 &&
    (first === 127 ||
      first === 10 ||
      (first === 192 && second === 168) ||
      (first === 172 && second! >= 16 && second! <= 31));
  const internal =
    privateIpv4 ||
    hostname === "[::1]" ||
    /^[a-z][a-z0-9-]{0,62}$/.test(hostname);
  if (
    !internal ||
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new ServiceUnavailableException("OCR 服务须使用内网地址。");
  return url;
}

export class OcrProvider {
  async recognize(input: { bytes: Buffer; mime: string; page: number }) {
    const url = ocrEndpoint();
    const engine = process.env.HYPER_OCR_ENGINE;
    if (!url || !engine || !/^[a-zA-Z0-9][a-zA-Z0-9._/@-]{0,99}$/.test(engine))
      throw new ServiceUnavailableException(
        "管理员尚未配置内网 OCR 服务和版本。",
      );
    if (inFlight >= 2)
      throw new ServiceUnavailableException(
        "OCR 正在处理其他文档，请稍后再试。",
      );
    inFlight++;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": input.mime,
          "X-OCR-Page": String(input.page),
        },
        body: new Uint8Array(input.bytes),
        signal: AbortSignal.timeout(55000),
        redirect: "error",
      });
      if (response.status === 422) {
        await response.body?.cancel();
        throw new BadRequestException("OCR 无法处理所选文件或页码。");
      }
      if (
        !response.ok ||
        !response.headers
          .get("content-type")
          ?.toLowerCase()
          .startsWith("application/json") ||
        Number(response.headers.get("content-length")) > maxResponseBytes
      ) {
        await response.body?.cancel();
        throw new Error("invalid OCR response");
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("missing OCR response");
      let size = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > maxResponseBytes)
            throw new Error("OCR response too large");
          chunks.push(chunk.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const content = OcrPage.parse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
      );
      if (!content.blocks.some((block) => block.text.trim()))
        throw new BadRequestException(
          "此页没有可校对的识别文字，请检查页码和图像清晰度。",
        );
      return { engine, content };
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new ServiceUnavailableException(
        "内网 OCR 服务暂未返回可用结果，已保存版本可继续查看。",
      );
    } finally {
      inFlight--;
    }
  }
}

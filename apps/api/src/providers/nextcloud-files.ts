import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from "@nestjs/common";
import {
  FilePath,
  MAX_ATTACHMENT_BYTES,
  type SourceFile,
} from "@hyper/contracts";
import { XMLParser } from "fast-xml-parser";
import type { StorageProvider, ExtractedFile } from "./storage.js";
import {
  DocumentExtractor,
  DOCUMENT_PARSER_VERSION,
  MAX_DOCUMENT_BYTES,
  type DocumentFormat,
} from "../core/document-extraction.js";
import type { NextcloudConfig, SourceCredentials } from "./nextcloud.js";

const DAV = "DAV:",
  OC = "http://owncloud.org/ns";
export const MAX_FILE_BYTES = 65536,
  MAX_FILE_TEXT = 180000;
const DOCUMENT_MIMES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
function documentFormat(
  name: string,
  mime: string,
): DocumentFormat | undefined {
  const extension = name.toLowerCase().split(".").at(-1)!;
  return DOCUMENT_MIMES[extension] === mime
    ? (extension as DocumentFormat)
    : undefined;
}
export function fileParserVersion(file: Pick<SourceFile, "name" | "mime">) {
  return documentFormat(file.name, file.mime)
    ? DOCUMENT_PARSER_VERSION
    : "utf8-text-v1";
}
const REQUEST =
  '<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop><oc:fileid/><d:getetag/><d:getcontentlength/><d:getcontenttype/><d:resourcetype/></d:prop></d:propfind>';
type Element = { value: any; ns: Record<string, string> };
function children(parent: Element, uri: string, name: string): Element[] {
  if (!parent.value || typeof parent.value !== "object") return [];
  return Object.entries(parent.value).flatMap(([key, raw]) => {
    if (key.startsWith("@_") || key.startsWith("#") || key.startsWith("?"))
      return [];
    return (Array.isArray(raw) ? raw : [raw]).flatMap((value) => {
      const ns = { ...parent.ns };
      if (value && typeof value === "object")
        for (const [attr, text] of Object.entries(value)) {
          if (attr === "@_xmlns") ns[""] = String(text);
          else if (attr.startsWith("@_xmlns:"))
            ns[attr.slice(8)] = String(text);
        }
      const colon = key.indexOf(":"),
        prefix = colon < 0 ? "" : key.slice(0, colon),
        local = colon < 0 ? key : key.slice(colon + 1);
      return local === name && ns[prefix] === uri ? [{ value, ns }] : [];
    });
  });
}
function scalar(element?: Element) {
  const value = element?.value;
  if (typeof value === "string") return value;
  return value && typeof value["#text"] === "string" ? value["#text"] : "";
}
function property(element: Element, uri: string, name: string) {
  const values = children(element, uri, name);
  if (values.length > 1) throw new Error("Duplicate property");
  return values[0];
}
const same = (left: string[], right: string[]) =>
  JSON.stringify(left) === JSON.stringify(right);
export class UploadPathConflict extends ConflictException {
  constructor() {
    super("目标文件已存在，未覆盖；请重新创建上传。");
  }
}
export class FileSourceRejected extends HttpException {
  constructor(status: number) {
    super("文件来源拒绝访问或文件已变化。", status);
  }
}
async function bounded(response: Response, max: number) {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw new BadRequestException("文件或目录响应超过当前大小限制。");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > max)
        throw new BadRequestException("文件或目录响应超过当前大小限制。");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks);
}
/** Authenticated DAV only; no public links, redirects or arbitrary source URLs. */
export class NextcloudFilesProvider implements StorageProvider {
  constructor(
    private config: NextcloudConfig,
    private credentials: Pick<SourceCredentials, "loginName" | "appPassword">,
    private uid: string,
  ) {
    FilePath.parse([uid]);
  }
  private root(base = this.config.transportUrl) {
    return base + "/remote.php/dav/files/" + encodeURIComponent(this.uid) + "/";
  }
  private url(path: string[]) {
    return this.root() + FilePath.parse(path).map(encodeURIComponent).join("/");
  }
  private async request(
    path: string[],
    method: string,
    headers: Record<string, string> = {},
    body?: string,
  ) {
    let response: Response;
    try {
      response = await fetch(this.url(path), {
        method,
        body,
        redirect: "error",
        signal: AbortSignal.timeout(8000),
        headers: {
          "User-Agent": "Hyper Workspace/0.1",
          "Accept-Encoding": "identity",
          Authorization:
            "Basic " +
            Buffer.from(
              this.credentials.loginName + ":" + this.credentials.appPassword,
            ).toString("base64"),
          ...headers,
        },
      });
    } catch {
      throw new ServiceUnavailableException("文件来源暂时无法连接。");
    }
    if ([401, 403, 404, 410, 412, 429].includes(response.status)) {
      await response.body?.cancel();
      throw new FileSourceRejected(response.status);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ServiceUnavailableException("文件来源暂时不可用。");
    }
    return response;
  }
  private href(raw: string) {
    const value = new URL(raw, this.root());
    if (value.username || value.password || value.search || value.hash)
      throw new Error("Invalid href");
    for (const base of [this.config.transportUrl, this.config.publicUrl]) {
      const root = new URL(this.root(base));
      const prefix = root.pathname
        .replace(/\/$/, "")
        .split("/")
        .map(decodeURIComponent);
      const parts = value.pathname
        .replace(/\/$/, "")
        .split("/")
        .map(decodeURIComponent);
      if (
        value.origin === root.origin &&
        same(parts.slice(0, prefix.length), prefix)
      ) {
        return FilePath.parse(parts.slice(prefix.length));
      }
    }
    throw new Error("Foreign href");
  }
  private async properties(
    path: string[],
    depth: 0 | 1,
    requireCreate = false,
  ) {
    const response = await this.request(
      path,
      "PROPFIND",
      {
        Depth: String(depth),
        "Content-Type": "application/xml; charset=utf-8",
        Accept: "application/xml",
      },
      requireCreate
        ? REQUEST.replace("<oc:fileid/>", "<oc:fileid/><oc:permissions/>")
        : REQUEST,
    );
    if (response.status !== 207) {
      await response.body?.cancel();
      throw new ServiceUnavailableException("文件来源返回无效目录状态。");
    }
    const bytes = await bounded(response, 524288);
    try {
      const xml = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      // This protocol needs no DTD, comments or CDATA; block entity definitions before parsing.
      if (/<!/.test(xml)) throw new Error("Declarations forbidden");
      const parsed = new XMLParser({
        ignoreAttributes: false,
        parseTagValue: false,
        parseAttributeValue: false,
        trimValues: false,
        processEntities: true,
        maxNestedTags: 24,
      }).parse(xml, true);
      const roots = children({ value: parsed, ns: {} }, DAV, "multistatus");
      if (roots.length !== 1) throw new Error("Invalid root");
      const entries = children(roots[0]!, DAV, "response");
      if (!entries.length || entries.length > 501)
        throw new Error("Directory limit");
      const files: SourceFile[] = [],
        paths = new Set<string>();
      for (const entry of entries) {
        const selectedPath = this.href(scalar(property(entry, DAV, "href")));
        if (
          !same(selectedPath, path) &&
          !(
            depth === 1 &&
            selectedPath.length === path.length + 1 &&
            same(selectedPath.slice(0, -1), path)
          )
        )
          throw new Error("Path outside selection");
        let prop: Element | undefined;
        for (const status of children(entry, DAV, "propstat")) {
          if (
            !/^HTTP\/\d(?:\.\d)? 200(?:\s|$)/.test(
              scalar(property(status, DAV, "status")),
            )
          )
            continue;
          const next = property(status, DAV, "prop");
          if (!next || prop) throw new Error("Conflicting properties");
          prop = next;
        }
        if (!prop) throw new Error("No readable properties");
        const id = scalar(property(prop, OC, "fileid")).trim(),
          etag = scalar(property(prop, DAV, "getetag")).trim();
        if (
          !/^[1-9]\d{0,19}$/.test(id) ||
          !etag ||
          etag.length > 256 ||
          paths.has(JSON.stringify(selectedPath))
        )
          throw new Error("Invalid file identity");
        const kind = children(
          property(prop, DAV, "resourcetype") ?? { value: "", ns: {} },
          DAV,
          "collection",
        ).length
          ? "directory"
          : "file";
        if (
          requireCreate &&
          same(selectedPath, path) &&
          (kind !== "directory" ||
            !scalar(property(prop, OC, "permissions")).includes("C"))
        )
          throw new FileSourceRejected(403);
        const sizeText = scalar(property(prop, DAV, "getcontentlength")).trim(),
          size = sizeText ? Number(sizeText) : 0;
        if (!Number.isSafeInteger(size) || size < 0)
          throw new Error("Invalid file size");
        const mime =
            scalar(property(prop, DAV, "getcontenttype"))
              .trim()
              .toLowerCase()
              .split(";")[0] ?? "",
          name = selectedPath.at(-1) ?? "我的文件";
        files.push({
          id,
          etag,
          path: selectedPath,
          name,
          kind,
          size,
          mime,
          importable:
            kind === "file" &&
            ((size <= MAX_FILE_BYTES &&
              /\.(?:txt|md|markdown)$/i.test(name) &&
              ["text/plain", "text/markdown", "text/x-markdown"].includes(
                mime,
              )) ||
              (size <= MAX_DOCUMENT_BYTES && !!documentFormat(name, mime))),
        });
        paths.add(JSON.stringify(selectedPath));
      }
      if (!files.some((file) => same(file.path, path)))
        throw new Error("Missing selected resource");
      return files;
    } catch (error) {
      if (error instanceof FileSourceRejected) throw error;
      throw new ServiceUnavailableException(
        "文件目录格式、来源或范围不受支持。",
      );
    }
  }
  /** Nextcloud's live create permission on this employee's DAV directory, before any new-file intent. */
  async assertWritableDirectory(path: string[]) {
    await this.properties(path, 0, true);
  }
  /** A single conditional PUT to an employee-owned, newly generated path. Never retries. */
  async uploadNew(path: string[], bytes: Buffer) {
    if (!path.length || bytes.length < 1 || bytes.length > MAX_ATTACHMENT_BYTES)
      throw new BadRequestException("上传文件需在 1 字节至 8 MiB 内。");
    const response = await fetch(this.url(path), {
      method: "PUT",
      body: new Uint8Array(bytes),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization:
          "Basic " +
          Buffer.from(
            this.credentials.loginName + ":" + this.credentials.appPassword,
          ).toString("base64"),
        "User-Agent": "Hyper Workspace/0.1",
        "If-None-Match": "*",
        "Content-Type": "application/octet-stream",
      },
    });
    await response.body?.cancel();
    if (response.status === 412) throw new UploadPathConflict();
    if (response.status !== 201)
      throw new ServiceUnavailableException("上传结果需要核对。");
  }
  async list(path: string[]) {
    const values = await this.properties(path, 1);
    if (values.find((file) => same(file.path, path))?.kind !== "directory")
      throw new BadRequestException("所选位置不是文件夹。");
    return values
      .filter((file) => !same(file.path, path))
      .sort((a, b) =>
        a.kind === b.kind
          ? a.name.localeCompare(b.name)
          : a.kind === "directory"
            ? -1
            : 1,
      );
  }
  async stat(path: string[]) {
    return (await this.properties(path, 0)).find((file) =>
      same(file.path, path),
    )!;
  }
  async read(file: SourceFile) {
    return (await this.extract(file)).text;
  }
  /** Bounded binary download, independent of document parsing or model ingestion. */
  async download(file: SourceFile) {
    if (file.kind !== "file" || file.size > MAX_ATTACHMENT_BYTES)
      throw new BadRequestException(
        "当前支持 8 MiB 内的附件下载，请在来源中查看较大的文件。",
      );
    const response = await this.request(file.path, "GET", {
      "If-Match": file.etag,
    });
    if (response.status !== 200 || response.headers.get("etag") !== file.etag) {
      await response.body?.cancel();
      throw new ConflictException("附件已变化，请刷新消息后重试。");
    }
    const bytes = await bounded(response, MAX_ATTACHMENT_BYTES);
    if (bytes.length !== file.size)
      throw new ServiceUnavailableException("附件长度与来源信息不符。");
    return Buffer.from(bytes);
  }
  async extract(file: SourceFile): Promise<ExtractedFile> {
    if (!file.importable)
      throw new BadRequestException(
        "当前支持 64 KiB 内的短文本/Markdown，以及 8 MiB 内的 PDF/DOCX/XLSX/PPTX。",
      );
    const response = await this.request(file.path, "GET", {
      "If-Match": file.etag,
    });
    if (response.status !== 200 || response.headers.get("etag") !== file.etag) {
      await response.body?.cancel();
      throw new ConflictException("文件已变化，请重新选择。");
    }
    const format = documentFormat(file.name, file.mime);
    const bytes = await bounded(
      response,
      format ? MAX_DOCUMENT_BYTES : MAX_FILE_BYTES,
    );
    if (bytes.length !== file.size)
      throw new ServiceUnavailableException("文件内容长度与来源信息不符。");
    if (format)
      return new DocumentExtractor().extract(Buffer.from(bytes), format);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new BadRequestException("当前只支持有效的 UTF-8 文本。");
    }
    if (
      !text.trim() ||
      text.length > MAX_FILE_TEXT ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)
    )
      throw new BadRequestException(
        "文本为空、包含二进制控制内容或超过当前解析限制。",
      );
    return {
      text,
      parserVersion: "utf8-text-v1",
      format: "text",
      sections: [],
      warnings: [],
    };
  }
  async assertReadable(file: SourceFile) {
    const response = await this.request(file.path, "GET", {
      Range: "bytes=0-0",
      "If-Match": file.etag,
    });
    try {
      if (
        ![200, 206].includes(response.status) ||
        response.headers.get("etag") !== file.etag
      )
        throw new FileSourceRejected(412);
      const reader = response.body?.getReader();
      if (!reader)
        throw new ServiceUnavailableException("无法核验文件读取权限。");
      try {
        await reader.read();
      } finally {
        await reader.cancel().catch(() => {});
      }
    } finally {
      await response.body?.cancel().catch(() => {});
    }
  }
}

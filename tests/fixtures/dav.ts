import type { IncomingMessage, ServerResponse } from "node:http";
export interface DavFile {
  id: string;
  path: string[];
  content: Buffer;
  etag: string;
  mime: string;
  readers: Set<string>;
  blockedDownloads: Set<string>;
  fullReads: number;
  probes: number;
  afterRead?: () => void;
}
export const escapeXml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
export class DavFixture {
  files: DavFile[] = [];
  directoryPermissions = new Map<string, string>();
  next = 1000;
  outage = false;
  maliciousXml: string | undefined;
  add(
    owner: string,
    path: string[],
    text: string | Buffer,
    mime = "text/markdown",
  ) {
    const file: DavFile = {
      id: String(this.next++),
      path,
      content: typeof text === "string" ? Buffer.from(text) : text,
      etag: '"v1"',
      mime,
      readers: new Set([owner]),
      blockedDownloads: new Set(),
      fullReads: 0,
      probes: 0,
    };
    this.files.push(file);
    return file;
  }
  handle(req: IncomingMessage, res: ServerResponse, uid: string) {
    const parsed = new URL(req.url!, "http://127.0.0.1");
    if (!parsed.pathname.startsWith("/remote.php/dav/files/")) return false;
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    if (this.outage) {
      res.writeHead(503);
      res.end("source-outage-do-not-log");
      return true;
    }
    const parts = parsed.pathname.split("/").slice(4).map(decodeURIComponent);
    if (parts.shift() !== uid) {
      res.writeHead(403);
      res.end("source-private-user");
      return true;
    }
    if (parts.at(-1) === "") parts.pop();
    const path = parts,
      key = JSON.stringify(path),
      file = this.files.find(
        (f) => JSON.stringify(f.path) === key && f.readers.has(uid),
      );
    const visible = this.files.filter((f) => f.readers.has(uid)),
      directories = new Map<string, { id: string; path: string[] }>();
    directories.set("[]", { id: "1", path: [] });
    for (const f of visible)
      for (let length = 1; length < f.path.length; length++) {
        const prefix = f.path.slice(0, length);
        directories.set(JSON.stringify(prefix), {
          id: String(100 + length),
          path: prefix,
        });
      }
    const dir = directories.get(key);
    if (!file && !dir) {
      res.writeHead(404);
      res.end("source-private-file-body");
      return true;
    }
    if (req.method === "PROPFIND") {
      if (this.maliciousXml) {
        res.writeHead(207);
        res.end(this.maliciousXml);
        return true;
      }
      const root = "/remote.php/dav/files/" + encodeURIComponent(uid) + "/";
      const entry = (
        item: {
          id: string;
          path: string[];
          etag?: string;
          content?: Buffer;
          mime?: string;
        },
        folder = false,
      ) =>
        `<x:response><x:href>${escapeXml(root + item.path.map(encodeURIComponent).join("/") + (folder && item.path.length ? "/" : ""))}</x:href><x:propstat><x:prop><f:fileid>${item.id}</f:fileid><f:permissions>${folder ? escapeXml(this.directoryPermissions.get(uid) ?? "RCK") : "RW"}</f:permissions><x:getetag>${escapeXml(item.etag ?? '"directory"')}</x:getetag><x:getcontentlength>${item.content?.length ?? 0}</x:getcontentlength><x:getcontenttype>${folder ? "httpd/unix-directory" : item.mime}</x:getcontenttype><x:resourcetype>${folder ? "<x:collection/>" : ""}</x:resourcetype></x:prop><x:status>HTTP/1.1 200 OK</x:status></x:propstat></x:response>`;
      const output = [file ? entry(file) : entry(dir!, true)];
      if (req.headers.depth === "1" && dir) {
        for (const child of directories.values())
          if (
            child.path.length === path.length + 1 &&
            JSON.stringify(child.path.slice(0, -1)) === key
          )
            output.push(entry(child, true));
        for (const child of visible)
          if (
            child.path.length === path.length + 1 &&
            JSON.stringify(child.path.slice(0, -1)) === key
          )
            output.push(entry(child));
      }
      res.writeHead(207);
      res.end(
        `<?xml version="1.0"?><x:multistatus xmlns:x="DAV:" xmlns:f="http://owncloud.org/ns">${output.join("")}</x:multistatus>`,
      );
      return true;
    }
    if (req.method === "GET" && file) {
      if (file.blockedDownloads.has(uid)) {
        res.writeHead(403);
        res.end("metadata-only-not-readable");
        return true;
      }
      if (req.headers["if-match"] !== file.etag) {
        res.writeHead(412);
        res.end("changed");
        return true;
      }
      res.setHeader("ETag", file.etag);
      res.setHeader("Content-Type", file.mime);
      if (req.headers.range) {
        file.probes++;
        res.writeHead(206, {
          "Content-Range": `bytes 0-0/${file.content.length}`,
        });
        res.end(file.content.subarray(0, 1));
      } else {
        file.fullReads++;
        res.writeHead(200, { "Content-Length": file.content.length });
        res.end(file.content);
        file.afterRead?.();
      }
      return true;
    }
    res.writeHead(405);
    res.end();
    return true;
  }
}

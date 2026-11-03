import type { IncomingMessage, ServerResponse } from "node:http";

const xml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
export class CalDavFixture {
  people = new Map<
    string,
    { password: string; member: boolean; read: boolean; write: boolean }
  >();
  objects = new Map<string, { ical: string; version: number }>();
  writes = 0;
  mode: "ok" | "drop-before" | "drop-after" | "tamper" | "reject" = "ok";
  afterWrite?: () => Promise<void>;
  afterRead?: () => Promise<void>;
  add(uid: string, password: string) {
    this.people.set(uid, { password, member: true, read: true, write: true });
  }
  async handle(req: IncomingMessage, res: ServerResponse) {
    const auth = Buffer.from(
      req.headers.authorization?.replace(/^Basic /u, "") ?? "",
      "base64",
    ).toString();
    const colon = auth.indexOf(":"),
      uid = auth.slice(0, colon),
      person = this.people.get(uid);
    const json = (data: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ocs: { meta: { statuscode: status }, data } }));
    };
    if (!person || person.password !== auth.slice(colon + 1))
      return json({}, 401);
    const url = new URL(req.url!, "http://127.0.0.1");
    if (url.pathname === "/ocs/v2.php/cloud/user")
      return json({ id: uid, displayname: uid });
    if (url.pathname.endsWith("/groups"))
      return json({ groups: person.member ? ["members"] : [] });
    const home = "/remote.php/dav/calendars/" + encodeURIComponent(uid) + "/";
    const calendar = home + "personal/";
    if (!url.pathname.startsWith(home) || !person.read) {
      res.writeHead(404);
      res.end();
      return;
    }
    const multi = (rows: string) =>
      `<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${rows}</d:multistatus>`;
    const row = (href: string, prop: string) =>
      `<d:response><d:href>${href}</d:href><d:propstat><d:prop>${prop}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
    const sendXml = (body: string) => {
      res.writeHead(207, { "Content-Type": "application/xml" });
      res.end(body);
    };
    if (req.method === "PROPFIND" && url.pathname === home) {
      return sendXml(
        multi(
          row(
            calendar,
            "<d:displayname>个人日历</d:displayname><d:resourcetype><c:calendar/></d:resourcetype><d:current-user-privilege-set><d:privilege><d:read/></d:privilege>" +
              (person.write ? "<d:privilege><d:write/></d:privilege>" : "") +
              '</d:current-user-privilege-set><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set>',
          ),
        ),
      );
    }
    if (req.method === "REPORT" && url.pathname === calendar) {
      const resources = [...this.objects].filter(([key]) =>
        key.startsWith(uid + "/personal/"),
      );
      return sendXml(
        multi(
          resources
            .map(([key, obj]) =>
              row(
                calendar + key.split("/").at(-1),
                `<d:getetag>&quot;v${obj.version}&quot;</d:getetag><c:calendar-data>${xml(obj.ical)}</c:calendar-data>`,
              ),
            )
            .join(""),
        ),
      );
    }
    const objectId = decodeURIComponent(url.pathname.slice(calendar.length));
    if (
      !url.pathname.startsWith(calendar) ||
      !objectId ||
      objectId.includes("/")
    ) {
      res.writeHead(404);
      res.end();
      return;
    }
    const key = uid + "/personal/" + objectId,
      current = this.objects.get(key);
    if (req.method === "GET") {
      if (!current) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, {
        ETag: `"v${current.version}"`,
        "Content-Type": "text/calendar",
      });
      if (this.afterRead) {
        const hook = this.afterRead;
        this.afterRead = undefined;
        await hook();
      }
      res.end(current.ical);
      return;
    }
    if (req.method === "PUT" || req.method === "DELETE") {
      this.writes++;
      if (!person.write || this.mode === "reject") {
        res.writeHead(403);
        res.end();
        return;
      }
      if (
        (req.headers["if-none-match"] === "*" && current) ||
        (req.headers["if-match"] &&
          (!current || req.headers["if-match"] !== `"v${current.version}"`))
      ) {
        res.writeHead(412);
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (this.mode === "drop-before") {
        req.socket.destroy();
        return;
      }
      if (req.method === "DELETE") this.objects.delete(key);
      else {
        let ical = Buffer.concat(chunks).toString();
        if (this.mode === "tamper")
          ical = ical.replace("SUMMARY:", "SUMMARY:source-change-");
        this.objects.set(key, { ical, version: (current?.version ?? 0) + 1 });
      }
      if (this.afterWrite) {
        const hook = this.afterWrite;
        this.afterWrite = undefined;
        await hook();
      }
      if (this.mode === "drop-after") {
        req.socket.destroy();
        return;
      }
      res.writeHead(req.method === "DELETE" || current ? 204 : 201);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  }
}

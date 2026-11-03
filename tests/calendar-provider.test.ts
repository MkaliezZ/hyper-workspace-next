import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  calendarUid,
  CalendarDeliveryUnknown,
  CalendarSourceRejected,
  NextcloudCalendarProvider,
} from "../apps/api/src/providers/nextcloud-calendar.js";

// Protocol server only; this is not proof of a real Nextcloud integration.
const home = "/remote.php/dav/calendars/employee/";
const uid = "synthetic-calendar-uid";
const ical = [
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Hyper//Calendar Test//EN",
  "BEGIN:VTIMEZONE",
  "TZID:Asia/Shanghai",
  "BEGIN:STANDARD",
  "DTSTART:19700101T000000",
  "TZOFFSETFROM:+0800",
  "TZOFFSETTO:+0800",
  "END:STANDARD",
  "END:VTIMEZONE",
  "BEGIN:VEVENT",
  `UID:${uid}`,
  "DTSTAMP:20261104T000000Z",
  "DTSTART;TZID=Asia/Shanghai:20261104T090000",
  "DTEND;TZID=Asia/Shanghai:20261104T100000",
  "RRULE:FREQ=WEEKLY;COUNT=4",
  "EXDATE;TZID=Asia/Shanghai:20261111T090000",
  "SUMMARY:项目排期",
  "END:VEVENT",
  "BEGIN:VEVENT",
  `UID:${uid}`,
  "RECURRENCE-ID;TZID=Asia/Shanghai:20261118T090000",
  "DTSTART;TZID=Asia/Shanghai:20261118T110000",
  "DTEND;TZID=Asia/Shanghai:20261118T120000",
  "SUMMARY:修改后的单次会议",
  "END:VEVENT",
  "END:VCALENDAR",
  "",
].join("\r\n");
const escape = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
const multi = (rows: string) =>
  `<a:multistatus xmlns:a="DAV:" xmlns:b="urn:ietf:params:xml:ns:caldav">${rows}</a:multistatus>`;
const propstat = (properties: string, code = 200) =>
  `<a:propstat><a:prop>${properties}</a:prop><a:status>HTTP/1.1 ${code} Result</a:status></a:propstat>`;
const row = (href: string, properties: string) =>
  `<a:response><a:href>${href}</a:href>${propstat(properties)}</a:response>`;
const calendar = (id: string, privileges: string) =>
  row(
    home + id + "/",
    `<a:resourcetype><a:collection/><b:calendar/></a:resourcetype><a:displayname>项目 &amp; 排期</a:displayname><a:current-user-privilege-set>${privileges
      .split(",")
      .filter(Boolean)
      .map((p) => `<a:privilege><a:${p}/></a:privilege>`)
      .join(
        "",
      )}</a:current-user-privilege-set><b:supported-calendar-component-set><b:comp name="VEVENT"/></b:supported-calendar-component-set>`,
  );
const event = (href = home + "personal/event.ics") =>
  row(
    href,
    `<a:getetag>&quot;v1&quot;</a:getetag><b:calendar-data>${escape(ical)}</b:calendar-data>`,
  );
let handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;
const requests: {
  method: string;
  url: string;
  body: string;
  headers: IncomingMessage["headers"];
}[] = [];
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString();
  requests.push({
    method: req.method!,
    url: req.url!,
    body,
    headers: req.headers,
  });
  handler(req, res, body);
});
let provider: NextcloudCalendarProvider;
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base =
    "http://127.0.0.1:" + (server.address() as { port: number }).port;
  provider = new NextcloudCalendarProvider(
    {
      publicUrl: base,
      transportUrl: base,
      providerKey: "nextcloud:test",
      workspaceId: "test",
      memberGroup: "members",
      bootstrapAdminIds: [],
    },
    {
      loginName: "email-login@example.invalid",
      appPassword: "synthetic-calendar-password",
    },
    "employee",
  );
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
const reply = (res: ServerResponse, xml: string) => {
  res.writeHead(207, { "Content-Type": "application/xml" });
  res.end(xml);
};

test("CalDAV discovers current UID calendars using namespace semantics and current source privileges", async () => {
  handler = (req, res) => {
    assert.equal(req.method, "PROPFIND");
    assert.equal(req.url, home);
    assert.equal(req.headers.depth, "1");
    assert.equal(
      Buffer.from(req.headers.authorization!.slice(6), "base64").toString(),
      "email-login@example.invalid:synthetic-calendar-password",
    );
    reply(
      res,
      multi(
        calendar("personal", "read,write") +
          calendar("readonly", "read") +
          calendar("hidden", "write"),
      ),
    );
  };
  assert.deepEqual(await provider.calendars(), [
    {
      id: "personal",
      name: "项目 & 排期",
      canRead: true,
      canCreate: true,
      canUpdate: true,
      canDelete: true,
    },
    {
      id: "readonly",
      name: "项目 & 排期",
      canRead: true,
      canCreate: false,
      canUpdate: false,
      canDelete: false,
    },
  ]);
});

test("CalDAV query bounds UTC window and preserves recurrence exceptions plus timezone data", async () => {
  handler = (_req, res, body) => {
    assert.match(body, /start="20261101T000000Z" end="20261201T000000Z"/);
    assert.doesNotMatch(body, /<c:expand/);
    reply(res, multi(event()));
  };
  const objects = await provider.query("personal", {
    start: "2026-11-01T00:00:00Z",
    end: "2026-12-01T00:00:00Z",
  });
  assert.deepEqual(objects, [
    { calendarId: "personal", objectId: "event.ics", etag: '"v1"', ical, uid },
  ]);
  const before = requests.length;
  for (const window of [
    { start: "2026-11-01T00:00:00Z", end: "2027-12-01T00:00:00Z" },
    { start: "2026-11-01T00:00:00Z", end: "2026-11-01T00:00:00Z" },
    { start: "2026-02-30T00:00:00Z", end: "2026-03-01T00:00:00Z" },
    { start: '2026-11-01T00:00:00Z"/>', end: "2026-12-01T00:00:00Z" },
  ])
    await assert.rejects(provider.query("personal", window));
  assert.equal(requests.length, before);
});

test("CalDAV merges successful propstat blocks and does not invent absent write privileges", async () => {
  handler = (_req, res) =>
    reply(
      res,
      multi(
        `<a:response><a:href>${home}personal/</a:href>${propstat("<a:resourcetype><b:calendar/></a:resourcetype>")}${propstat('<b:supported-calendar-component-set><b:comp name="VEVENT"/></b:supported-calendar-component-set>')}${propstat("<a:current-user-privilege-set><a:privilege><a:read/></a:privilege></a:current-user-privilege-set>")}${propstat("<a:displayname/>", 404)}</a:response>`,
      ),
    );
  const [calendar] = await provider.calendars();
  assert.equal(calendar?.canRead, true);
  assert.equal(calendar?.canUpdate, false);
});

test("CalDAV rejects foreign, sibling, traversal, encoded separators and duplicate source references", async () => {
  for (const href of [
    "https://foreign.invalid/private.ics",
    home.replace("employee", "other") + "personal/e.ics",
    home + "personal/%2e%2e/e.ics",
    home + "personal/a%2Fb.ics",
    home + "personal/a%5Cb.ics",
    home + "personal/e.ics?secret=x",
    home + "personal/e.ics#fragment",
    home + "personal/a%00b.ics",
    home + "personal/%252e%252e",
    home + "other/e.ics",
  ]) {
    handler = (_req, res) => reply(res, multi(event(href)));
    await assert.rejects(
      provider.query("personal", {
        start: "2026-11-01T00:00:00Z",
        end: "2026-12-01T00:00:00Z",
      }),
      /不完整或格式无效/,
    );
  }
  handler = (_req, res) => reply(res, multi(event() + event()));
  await assert.rejects(
    provider.query("personal", {
      start: "2026-11-01T00:00:00Z",
      end: "2026-12-01T00:00:00Z",
    }),
  );
});

test("CalDAV rejects spoofed namespaces, DTD/entities, partial failures and oversized lists", async () => {
  for (const xml of [
    '<x:multistatus xmlns:x="evil"/>',
    '<!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + multi(""),
    multi(
      `<a:response><a:href>${home}personal/e.ics</a:href><a:status>HTTP/1.1 507 Too many matches</a:status></a:response>`,
    ),
    multi(
      event().replace(
        "<a:getetag>",
        '<a:getetag>"duplicate"</a:getetag><a:getetag>',
      ),
    ),
    multi(Array(502).fill(event()).join("")),
  ]) {
    handler = (_req, res) => reply(res, xml);
    await assert.rejects(
      provider.query("personal", {
        start: "2026-11-01T00:00:00Z",
        end: "2026-12-01T00:00:00Z",
      }),
    );
  }
  handler = (_req, res) => {
    res.writeHead(207, { "Content-Length": 3 * 1024 * 1024 });
    res.end();
  };
  await assert.rejects(provider.calendars());
});

test("CalDAV GET requires a valid source version and returns untouched original bytes as text", async () => {
  handler = (_req, res) => {
    res.writeHead(200, { ETag: '"v1"' });
    res.end(ical);
  };
  assert.equal((await provider.read("personal", "event.ics")).ical, ical);
  handler = (_req, res) => {
    res.writeHead(200);
    res.end(ical);
  };
  await assert.rejects(
    provider.read("personal", "event.ics"),
    /完整内容与版本/,
  );
});

test("CalDAV creation is create-only; replacement and deletion require exact strong ETags", async () => {
  handler = (req, res, body) => {
    if (req.method === "PUT") assert.equal(body, ical);
    res.writeHead(req.headers["if-none-match"] ? 201 : 204);
    res.end();
  };
  await provider.create("personal", "new.ics", ical);
  assert.equal(requests.at(-1)?.headers["if-none-match"], "*");
  await provider.replace("personal", "new.ics", '"v1"', ical);
  assert.equal(requests.at(-1)?.headers["if-match"], '"v1"');
  await provider.remove("personal", "new.ics", '"v2"');
  assert.equal(requests.at(-1)?.headers["if-match"], '"v2"');
  const before = requests.length;
  for (const invalid of ['W/"v1"', "*", '"v1"\r\nX:bad'])
    await assert.rejects(provider.remove("personal", "new.ics", invalid));
  for (const invalid of ["..", "a/b", "a%2Fb", "a?x", "a\\b"])
    await assert.rejects(provider.read("personal", invalid));
  assert.equal(requests.length, before);
});

test("CalDAV conflict and revoked source authorization are explicit and never retried", async () => {
  for (const status of [401, 403, 404, 409, 412, 423, 429]) {
    handler = (_req, res) => {
      res.writeHead(status);
      res.end("upstream-secret-never-return");
    };
    const before = requests.length;
    await assert.rejects(
      provider.replace("personal", "e.ics", '"v1"', ical),
      (error) => {
        assert.ok(error instanceof CalendarSourceRejected);
        assert.equal(error.getStatus(), status);
        assert.doesNotMatch(error.message, /upstream-secret/);
        return true;
      },
    );
    assert.equal(requests.length, before + 1);
  }
});

test("CalDAV lost/5xx/redirect mutation responses stay unknown without automatic replay", async () => {
  for (const code of [0, 500, 503, 302, 200]) {
    handler = (req, res) => {
      if (!code) req.socket.destroy();
      else {
        res.writeHead(
          code,
          code === 302 ? { Location: "https://foreign.invalid/" } : {},
        );
        res.end();
      }
    };
    const before = requests.length;
    await assert.rejects(
      provider.create("personal", "e.ics", ical),
      CalendarDeliveryUnknown,
    );
    assert.equal(requests.length, before + 1);
  }
});

test("Calendar envelope preserves one recurring UID but rejects mixed UIDs, unsupported objects and implicit invitations", async () => {
  assert.equal(calendarUid(ical), uid);
  for (const invalid of [
    "",
    "not ical",
    ical.replace(`UID:${uid}`, "UID:another"),
    ical.replaceAll("VEVENT", "VTODO"),
    ical.replace("VERSION:2.0", "VERSION:1.0"),
    "x".repeat(262145),
  ])
    assert.throws(() => calendarUid(invalid));
  for (const scheduling of [
    ical.replace("VERSION:2.0", "VERSION:2.0\r\nMETHOD:REQUEST"),
    ical.replace(
      "SUMMARY:项目排期",
      "SUMMARY:项目排期\r\nATTENDEE:mailto:someone@example.invalid",
    ),
    ical.replace(
      "SUMMARY:项目排期",
      "SUMMARY:项目排期\r\nORGANIZER:mailto:someone@example.invalid",
    ),
  ]) {
    assert.equal(calendarUid(scheduling), uid);
    assert.throws(() => calendarUid(scheduling, true), /专用排期服务/);
  }
});

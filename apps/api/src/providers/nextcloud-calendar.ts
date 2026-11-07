import {
  BadRequestException,
  HttpException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { XMLParser } from "fast-xml-parser";
import ICAL from "ical.js";
import { createHash } from "node:crypto";
import type { NextcloudConfig, SourceCredentials } from "./nextcloud.js";
import type {
  CalendarObject,
  CalendarProvider,
  CalendarWindow,
  ExpandedCalendarObject,
  SourceCalendar,
} from "./calendar.js";

const DAV = "DAV:";
const CALDAV = "urn:ietf:params:xml:ns:caldav";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ICAL_BYTES = 256 * 1024;
const MAX_OBJECTS = 500;
const HEADER = '<?xml version="1.0" encoding="utf-8"?>';
const DISCOVER =
  HEADER +
  `<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:prop><d:resourcetype/><d:displayname/><d:current-user-privilege-set/><d:owner/><c:supported-calendar-component-set/><c:calendar-timezone/></d:prop></d:propfind>`;

const PRINCIPALS = "/remote.php/dav/principals/users/";
const SABRE = "http://sabredav.org/ns";
const FIND_ADDRESS =
  HEADER +
  `<d:propfind xmlns:d="DAV:" xmlns:c="${CALDAV}" xmlns:s="${SABRE}"><d:prop><d:principal-URL/><s:email-address/><c:calendar-user-address-set/><c:calendar-user-type/></d:prop></d:propfind>`;

export class CalendarSourceRejected extends HttpException {
  constructor(status: number) {
    super("日历来源拒绝访问，或对象版本已变化。", status);
  }
}

/** Caller must persist an unknown outcome and reconcile; never retry a write blindly. */
export class CalendarDeliveryUnknown extends ServiceUnavailableException {
  constructor() {
    super("日历写入结果尚未核实，请核对来源对象后再继续。", {
      description: "calendar_delivery_unknown",
    });
  }
}

function segment(value: string) {
  if (
    !value ||
    value.length > 255 ||
    /[\u0000-\u001f\u007f/\\%?#]/u.test(value) ||
    value === "." ||
    value === ".."
  )
    throw new BadRequestException("日历对象标识无效。");
  return value;
}

function etag(value: string, strong = false) {
  if (
    !/^(?:W\/)?"[^"\x00-\x20\x7f]*"$/u.test(value) ||
    value.length > 512 ||
    (strong && value.startsWith("W/"))
  )
    throw new BadRequestException("日历版本标识无效，请重新读取。");
  return value;
}

function utc(value: string) {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value.replace("Z", ".000Z")
  )
    throw new BadRequestException("日历查询时间必须是有效的 UTC 时间。");
  return Date.parse(value);
}

function range(window: CalendarWindow) {
  const start = utc(window.start),
    end = utc(window.end);
  if (end <= start || end - start > 93 * 86400000)
    throw new BadRequestException("日历查询范围须大于零且不超过 93 天。");
  return {
    start: window.start.replace(/[-:]/gu, ""),
    end: window.end.replace(/[-:]/gu, ""),
  };
}

/** Validate the envelope without flattening recurring exceptions or timezone definitions. */
export function calendarUid(
  ical: string,
  write: boolean | "scheduling" = false,
) {
  if (Buffer.byteLength(ical) > MAX_ICAL_BYTES || /\u0000/u.test(ical))
    throw new BadRequestException("日历对象超过大小限制或包含无效内容。");
  try {
    const component = new ICAL.Component(ICAL.parse(ical));
    if (
      component.name !== "vcalendar" ||
      component.getFirstPropertyValue("version") !== "2.0"
    )
      throw new Error("Invalid calendar");
    const events = component.getAllSubcomponents("vevent");
    if (
      !events.length ||
      events.length > 500 ||
      component
        .getAllSubcomponents()
        .some((c) => !["vevent", "vtimezone"].includes(c.name))
    )
      throw new Error("Invalid events");
    const uids = events.map((e) => e.getAllProperties("uid"));
    const uid = uids[0]?.[0]?.getFirstValue();
    if (
      typeof uid !== "string" ||
      !uid ||
      uid.length > 1024 ||
      /[\r\n\u0000]/u.test(uid) ||
      uids.some((p) => p.length !== 1 || p[0]?.getFirstValue() !== uid)
    )
      throw new Error("Invalid uid");
    if (
      write &&
      (component.hasProperty("method") ||
        (write !== "scheduling" &&
          events.some(
            (e) => e.hasProperty("attendee") || e.hasProperty("organizer"),
          )))
    )
      throw new Error(
        "Scheduling requires a separately authorized scheduling service",
      );
    return uid;
  } catch {
    throw new BadRequestException(
      write
        ? "日历内容无效；参会邀请与会议通知需通过专用排期服务发送。"
        : "来源未返回完整有效的 iCalendar 对象。",
    );
  }
}

async function bounded(response: Response, max: number) {
  if (Number(response.headers.get("content-length")) > max) {
    await response.body?.cancel();
    throw new Error("Response too large");
  }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!reader) return "";
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > max) throw new Error("Response too large");
      chunks.push(part.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } finally {
    await reader.cancel().catch(() => {});
  }
}

type Element = { value: any; ns: Record<string, string> };
function children(parent: Element, uri: string, name: string): Element[] {
  if (!parent.value || typeof parent.value !== "object") return [];
  return Object.entries(parent.value).flatMap(([key, raw]) => {
    if (/^[@#?]/u.test(key)) return [];
    return (Array.isArray(raw) ? raw : [raw]).flatMap((value) => {
      const ns = { ...parent.ns };
      if (value && typeof value === "object") {
        for (const [attr, text] of Object.entries(value)) {
          if (attr === "@_xmlns") ns[""] = String(text);
          else if (attr.startsWith("@_xmlns:"))
            ns[attr.slice(8)] = String(text);
        }
      }
      const colon = key.indexOf(":"),
        prefix = colon < 0 ? "" : key.slice(0, colon);
      const local = colon < 0 ? key : key.slice(colon + 1);
      return local === name && ns[prefix] === uri ? [{ value, ns }] : [];
    });
  });
}
function one(parent: Element, uri: string, name: string) {
  const all = children(parent, uri, name);
  if (all.length > 1) throw new Error("Duplicate XML property");
  return all[0];
}
function scalar(element?: Element) {
  if (typeof element?.value === "string") return element.value;
  return typeof element?.value?.["#text"] === "string"
    ? element.value["#text"]
    : "";
}
function status(element?: Element) {
  const match = /^HTTP\/1\.[01] ([1-5]\d{2})(?: .*)?$/u.exec(
    scalar(element).trim(),
  );
  if (!match) throw new Error("Invalid DAV status");
  return Number(match[1]);
}
function multistatus(xml: string) {
  if (/<!\s*(?:DOCTYPE|ENTITY)/iu.test(xml)) throw new Error("DTD forbidden");
  const parsed = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    processEntities: {
      enabled: true,
      maxExpandedLength: MAX_RESPONSE_BYTES,
      maxTotalExpansions: MAX_RESPONSE_BYTES,
    },
    // Numeric XML references (e.g. Sabre's &#13;) need explicit support in
    // fast-xml-parser 5.11. Only the five XML predefined names are enabled.
    // @ts-expect-error 5.11.2 runtime supports a name map; its bundled declaration only lists boolean.
    htmlEntities: { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" },
    maxNestedTags: 24,
  }).parse(xml, true);
  const root = one({ value: parsed, ns: {} }, DAV, "multistatus");
  if (!root || one(root, DAV, "responsedescription")) {
    // A description may carry a truncation/failure message: do not claim complete data.
    throw new Error("Incomplete calendar response");
  }
  const responses = children(root, DAV, "response");
  if (responses.length > MAX_OBJECTS + 1)
    throw new Error("Too many calendar objects");
  return responses.map((response) => {
    const href = scalar(one(response, DAV, "href"));
    if (!href) throw new Error("Missing href");
    const directStatus = one(response, DAV, "status");
    if (directStatus && status(directStatus) !== 200)
      throw new Error("Partial source failure");
    const props: Element[] = [];
    for (const part of children(response, DAV, "propstat")) {
      if (status(one(part, DAV, "status")) === 200) {
        const prop = one(part, DAV, "prop");
        if (!prop) throw new Error("Missing properties");
        props.push(prop);
      }
    }
    function property(uri: string, name: string) {
      const all = props.flatMap((prop) => children(prop, uri, name));
      if (all.length > 1) throw new Error("Duplicate DAV properties");
      return all[0];
    }
    return { href, property };
  });
}

/** Scoped to the authenticated employee's home. Never follows source-controlled URLs. */
export class NextcloudCalendarProvider implements CalendarProvider {
  private readonly path: string;
  constructor(
    private readonly config: NextcloudConfig,
    private readonly credentials: Pick<
      SourceCredentials,
      "loginName" | "appPassword"
    >,
    remoteUid: string,
  ) {
    this.path =
      "/remote.php/dav/calendars/" +
      encodeURIComponent(segment(remoteUid)) +
      "/";
  }
  private url(calendarId?: string, objectId?: string) {
    return (
      this.config.transportUrl +
      this.path +
      (calendarId === undefined
        ? ""
        : encodeURIComponent(segment(calendarId)) + "/") +
      (objectId === undefined ? "" : encodeURIComponent(segment(objectId)))
    );
  }
  private reference(href: string) {
    // URL normalizes dot segments; reject them before normalization as well.
    if (/\\|[\u0000-\u0020\u007f]/u.test(href)) throw new Error("Invalid href");
    for (const part of href.split(/[/?#]/u)) {
      const decoded = decodeURIComponent(part);
      if (
        decoded === "." ||
        decoded === ".." ||
        /[/\\\u0000-\u001f\u007f]/u.test(decoded)
      )
        throw new Error("Unsafe href");
    }
    const target = new URL(href, this.config.publicUrl + this.path);
    if (target.username || target.password || target.search || target.hash)
      throw new Error("Invalid href");
    for (const base of [this.config.publicUrl, this.config.transportUrl]) {
      const home = new URL(base + this.path);
      if (
        target.origin !== home.origin ||
        !target.pathname.startsWith(home.pathname)
      )
        continue;
      const suffix = target.pathname
        .slice(home.pathname.length)
        .replace(/\/$/u, "");
      return suffix
        ? suffix.split("/").map((p) => segment(decodeURIComponent(p)))
        : [];
    }
    throw new Error("Calendar outside current employee home");
  }
  private async request(url: string, init: RequestInit, writing = false) {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: {
          ...init.headers,
          Authorization:
            "Basic " +
            Buffer.from(
              this.credentials.loginName + ":" + this.credentials.appPassword,
            ).toString("base64"),
          "Accept-Encoding": "identity",
        },
      });
    } catch {
      if (writing) throw new CalendarDeliveryUnknown();
      throw new ServiceUnavailableException("日历来源暂不可用。");
    }
    if (
      response.status >= 500 ||
      response.status === 408 ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel();
      if (writing) throw new CalendarDeliveryUnknown();
      throw new ServiceUnavailableException("日历来源暂不可用。");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new CalendarSourceRejected(
        [401, 403, 404, 409, 410, 412, 423, 429].includes(response.status)
          ? response.status
          : 502,
      );
    }
    return response;
  }
  private principalUid(href: string) {
    if (!href || /[\\\u0000-\u0020\u007f]/u.test(href)) return undefined;
    try {
      if (
        href
          .split("/")
          .some((part) => /^\.{1,2}$/u.test(decodeURIComponent(part)))
      )
        return undefined;
      const target = new URL(href, this.config.publicUrl + PRINCIPALS);
      if (target.username || target.password || target.search || target.hash)
        return undefined;
      for (const base of [this.config.publicUrl, this.config.transportUrl]) {
        const expected = new URL(base + PRINCIPALS);
        if (
          target.origin !== expected.origin ||
          !target.pathname.startsWith(expected.pathname)
        )
          continue;
        const uid = decodeURIComponent(
          target.pathname.slice(expected.pathname.length).replace(/\/$/u, ""),
        );
        return segment(uid);
      }
    } catch {
      return undefined;
    }
  }

  /** Resolve only an exact employee principal at the configured DAV origin. */
  async schedulingAddress(uid: string) {
    const url =
      this.config.transportUrl + PRINCIPALS + encodeURIComponent(segment(uid));
    const response = await this.request(url, {
      method: "PROPFIND",
      headers: { Depth: "0", "Content-Type": "application/xml; charset=utf-8" },
      body: FIND_ADDRESS,
    });
    try {
      if (response.status !== 207)
        throw new Error("Expected principal multistatus");
      const [row, extra] = multistatus(await bounded(response, 65536));
      if (!row || extra || this.principalUid(row.href) !== uid)
        throw new Error("Unexpected principal");
      const principal = row.property(DAV, "principal-URL");
      if (
        !principal ||
        this.principalUid(scalar(one(principal, DAV, "href"))) !== uid
      )
        throw new Error("Principal URL mismatch");
      const type = scalar(row.property(CALDAV, "calendar-user-type"));
      const email = scalar(row.property(SABRE, "email-address"));
      const addresses = row.property(CALDAV, "calendar-user-address-set");
      const address = "mailto:" + email;
      if (
        type !== "INDIVIDUAL" ||
        !/^[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+$/u.test(email) ||
        email.length > 254 ||
        !addresses ||
        !children(addresses, DAV, "href").some((href) => {
          const value = scalar(href);
          return value === address || decodeURIComponent(value) === address;
        })
      )
        throw new Error("No verified individual calendar address");
      return address;
    } catch {
      await response.body?.cancel().catch(() => {});
      throw new ServiceUnavailableException("无法核实员工的来源日历地址。");
    }
  }
  async calendars(): Promise<SourceCalendar[]> {
    const response = await this.request(this.url(), {
      method: "PROPFIND",
      headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
      body: DISCOVER,
    });
    try {
      if (response.status !== 207) throw new Error("Expected multistatus");
      const rows = multistatus(await bounded(response, MAX_RESPONSE_BYTES));
      const found = new Set<string>();
      return rows.flatMap((row) => {
        const ref = this.reference(row.href);
        if (!ref.length) return [];
        if (ref.length !== 1) throw new Error("Invalid calendar reference");
        const id = ref[0]!;
        if (found.has(id)) throw new Error("Duplicate calendar");
        found.add(id);
        const type = row.property(DAV, "resourcetype");
        if (!type || !one(type, CALDAV, "calendar")) return [];
        const components = row.property(
          CALDAV,
          "supported-calendar-component-set",
        );
        if (
          !components ||
          !children(components, CALDAV, "comp").some(
            (c) => c.value?.["@_name"] === "VEVENT",
          )
        )
          return [];
        const privileges = row.property(DAV, "current-user-privilege-set");
        const has = (name: string) =>
          !!privileges &&
          children(privileges, DAV, "privilege").some((p) => one(p, DAV, name));
        const all = has("all"),
          write = all || has("write");
        const canRead = all || has("read");
        if (!canRead) return [];
        const zoneText = scalar(row.property(CALDAV, "calendar-timezone"));
        let timeZone: SourceCalendar["timeZone"];
        if (zoneText) {
          if (Buffer.byteLength(zoneText) > 65536)
            throw new Error("Source timezone too large");
          let zoneId: string | null = null;
          try {
            const zones = new ICAL.Component(
              ICAL.parse(zoneText),
            ).getAllSubcomponents("vtimezone");
            const id = zones[0]?.getFirstPropertyValue("tzid");
            const observances =
              zones[0]
                ?.getAllSubcomponents()
                .filter((c) => ["standard", "daylight"].includes(c.name)) ?? [];
            const valid =
              observances.length > 0 &&
              observances.every((c) => {
                const start = c.getFirstPropertyValue("dtstart"),
                  from = c.getFirstPropertyValue("tzoffsetfrom"),
                  to = c.getFirstPropertyValue("tzoffsetto");
                return (
                  start instanceof ICAL.Time &&
                  !start.isDate &&
                  from instanceof ICAL.UtcOffset &&
                  to instanceof ICAL.UtcOffset &&
                  Math.abs(from.toSeconds()) < 86400 &&
                  Math.abs(to.toSeconds()) < 86400
                );
              });
            if (
              zones.length === 1 &&
              typeof id === "string" &&
              id.length <= 255 &&
              valid
            )
              zoneId = id;
          } catch {
            /* Invalid timezone definitions remain explicit uncertainty. */
          }
          timeZone = {
            id: zoneId,
            revision: createHash("sha256").update(zoneText).digest("hex"),
          };
        }
        const owner = row.property(DAV, "owner");
        const ownerUid = owner
          ? this.principalUid(scalar(one(owner, DAV, "href")))
          : undefined;
        return [
          {
            ...(ownerUid ? { ownerUid } : {}),
            ...(timeZone ? { timeZone } : {}),
            id,
            name: scalar(row.property(DAV, "displayname")) || id,
            canRead,
            canCreate: write || has("bind"),
            canUpdate: write || has("write-content"),
            canDelete: write || has("unbind"),
          },
        ];
      });
    } catch {
      await response.body?.cancel().catch(() => {});
      throw new ServiceUnavailableException(
        "来源日历列表不完整或格式无效，未返回部分结果。",
      );
    }
  }
  async query(
    calendarId: string,
    window: CalendarWindow,
  ): Promise<CalendarObject[]> {
    return this.queryObjects(calendarId, window, false);
  }
  async occurrences(
    calendarId: string,
    window: CalendarWindow,
  ): Promise<ExpandedCalendarObject[]> {
    return (await this.queryObjects(calendarId, window, true)).map(
      (object) => ({ ...object, representation: "expanded" }),
    );
  }
  private async queryObjects(
    calendarId: string,
    window: CalendarWindow,
    expand: boolean,
  ): Promise<CalendarObject[]> {
    const interval = range(window);
    const body =
      HEADER +
      `<c:calendar-query xmlns:d="DAV:" xmlns:c="${CALDAV}"><d:prop><d:getetag/><c:calendar-data>${expand ? `<c:expand start="${interval.start}" end="${interval.end}"/>` : ""}</c:calendar-data></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${interval.start}" end="${interval.end}"/></c:comp-filter></c:comp-filter></c:filter></c:calendar-query>`;
    const response = await this.request(this.url(calendarId), {
      method: "REPORT",
      headers: { Depth: "1", "Content-Type": "application/xml; charset=utf-8" },
      body,
    });
    try {
      if (response.status !== 207) throw new Error("Expected multistatus");
      const rows = multistatus(await bounded(response, MAX_RESPONSE_BYTES));
      if (rows.length > MAX_OBJECTS) throw new Error("Too many objects");
      const seen = new Set<string>();
      return rows.map((row) => {
        const ref = this.reference(row.href);
        if (ref.length !== 2 || ref[0] !== calendarId || seen.has(ref[1]!))
          throw new Error("Invalid event reference");
        seen.add(ref[1]!);
        // XML 1.0 normalizes literal CRLF. Restore RFC5545 line endings without
        // serializing/replacing the original recurring master and exceptions.
        const ical = scalar(row.property(CALDAV, "calendar-data")).replace(
          /\r?\n/gu,
          "\r\n",
        );
        return {
          calendarId,
          objectId: ref[1]!,
          etag: etag(scalar(row.property(DAV, "getetag"))),
          ical,
          uid: calendarUid(ical),
        };
      });
    } catch {
      await response.body?.cancel().catch(() => {});
      throw new ServiceUnavailableException(
        "来源日程查询不完整或格式无效，未返回部分结果。",
      );
    }
  }
  async read(calendarId: string, objectId: string): Promise<CalendarObject> {
    const response = await this.request(this.url(calendarId, objectId), {
      method: "GET",
      headers: { Accept: "text/calendar" },
    });
    try {
      if (response.status !== 200) throw new Error("Unexpected response");
      const ical = await bounded(response, MAX_ICAL_BYTES);
      return {
        calendarId,
        objectId,
        etag: etag(response.headers.get("etag") || ""),
        ical,
        uid: calendarUid(ical),
      };
    } catch {
      await response.body?.cancel().catch(() => {});
      throw new ServiceUnavailableException("来源日程未返回完整内容与版本。");
    }
  }
  private async put(
    calendarId: string,
    objectId: string,
    ical: string,
    condition: Record<string, string>,
    scheduling = false,
  ) {
    calendarUid(ical, scheduling ? "scheduling" : true);
    const response = await this.request(
      this.url(calendarId, objectId),
      {
        method: "PUT",
        headers: {
          "Content-Type": "text/calendar; charset=utf-8",
          ...condition,
        },
        body: ical,
      },
      true,
    );
    await response.body?.cancel();
    // Acceptance isn't readback. Product service must verify UID/version and persist a receipt.
    if (![201, 204].includes(response.status))
      throw new CalendarDeliveryUnknown();
  }
  create(calendarId: string, objectId: string, ical: string) {
    return this.put(calendarId, objectId, ical, { "If-None-Match": "*" });
  }
  createMeeting(calendarId: string, objectId: string, ical: string) {
    return this.put(calendarId, objectId, ical, { "If-None-Match": "*" }, true);
  }
  replaceMeeting(
    calendarId: string,
    objectId: string,
    version: string,
    ical: string,
  ) {
    return this.put(
      calendarId,
      objectId,
      ical,
      { "If-Match": etag(version, true) },
      true,
    );
  }
  replace(calendarId: string, objectId: string, version: string, ical: string) {
    return this.put(calendarId, objectId, ical, {
      "If-Match": etag(version, true),
    });
  }
  async remove(calendarId: string, objectId: string, version: string) {
    const response = await this.request(
      this.url(calendarId, objectId),
      { method: "DELETE", headers: { "If-Match": etag(version, true) } },
      true,
    );
    await response.body?.cancel();
    if (response.status !== 204) throw new CalendarDeliveryUnknown();
  }
}

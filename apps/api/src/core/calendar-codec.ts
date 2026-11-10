import { BadRequestException, ConflictException } from "@nestjs/common";
import ICAL from "ical.js";
import { Temporal } from "@js-temporal/polyfill";
import {
  CalendarDraft,
  CalendarPatch,
  CalendarInterval,
  type CalendarCommandInput,
  type CalendarOccurrence,
  CalendarRepeat,
  type CalendarSeriesRule,
  type CalendarInvitationStatus,
  type CalendarMeeting,
} from "@hyper/contracts/calendar";
import { calendarUid } from "../providers/nextcloud-calendar.js";
import { stableDigest } from "./credentials.js";
import { recurrenceHorizon, zonedCalendarTimes } from "./calendar-zones.js";
type Component = InstanceType<typeof ICAL.Component>;

function interval(
  root: Component,
  component: Component,
  value: CalendarInterval,
  repeat?: CalendarRepeat,
) {
  const bound =
    value.kind === "zoned" || repeat ? recurrenceHorizon(value, repeat) : null;
  const times =
    value.kind === "zoned"
      ? zonedCalendarTimes(root, value, bound!.horizon)
      : [value.start, value.end].map((text) =>
          ICAL.Time.fromString(text, undefined),
        );
  for (const name of ["dtstart", "dtend", "duration"])
    component.removeAllProperties(name);
  for (const [index, name] of ["dtstart", "dtend"].entries()) {
    const time = times[index]!;
    const property = new ICAL.Property(name);
    property.setValue(time);
    if (value.kind === "zoned" && time.zone !== ICAL.Timezone.utcTimezone)
      property.setParameter("tzid", time.zone.tzid);
    component.addProperty(property);
  }
  if (bound?.rule) component.updatePropertyWithValue("rrule", bound.rule);
}
function stamp(root: Component, event: Component, commandId: string) {
  root.updatePropertyWithValue("x-hyper-command-id", commandId);
  event.updatePropertyWithValue(
    "dtstamp",
    ICAL.Time.fromJSDate(new Date(), true),
  );
}
function editFields(
  root: Component,
  event: Component,
  patch: ReturnType<typeof CalendarPatch.parse>,
) {
  if (patch.title !== undefined)
    event.updatePropertyWithValue("summary", patch.title);
  if (patch.description !== undefined)
    event.updatePropertyWithValue("description", patch.description);
  if (patch.location !== undefined)
    event.updatePropertyWithValue("location", patch.location);
  if (patch.interval) interval(root, event, patch.interval);
}

function bumpSequence(event: Component) {
  const previous = event.getFirstPropertyValue("sequence");
  if (
    previous !== null &&
    (typeof previous !== "number" || previous < 0 || previous > 2147483646)
  )
    throw new BadRequestException("日程序号无效。");
  event.updatePropertyWithValue(
    "sequence",
    (typeof previous === "number" ? previous : 0) + 1,
  );
}

export function createCalendarObject(
  raw: CalendarDraft,
  uid: string,
  commandId: string,
  participants?: { organizer: string; attendees: string[] },
) {
  const draft = CalendarDraft.parse(raw);
  const root = new ICAL.Component("vcalendar");
  root.updatePropertyWithValue("version", "2.0");
  root.updatePropertyWithValue("prodid", "-//Hyper Workspace//Calendar//EN");
  const event = new ICAL.Component("vevent");
  root.addSubcomponent(event);
  event.updatePropertyWithValue("uid", uid);
  event.updatePropertyWithValue("summary", draft.title);
  event.updatePropertyWithValue("description", draft.description);
  event.updatePropertyWithValue("location", draft.location);
  event.updatePropertyWithValue("sequence", 0);
  interval(root, event, draft.interval, draft.repeat);
  if (participants) {
    event.updatePropertyWithValue("organizer", participants.organizer);
    for (const address of participants.attendees) {
      const attendee = new ICAL.Property("attendee");
      attendee.setValue(address);
      attendee.setParameter("role", "REQ-PARTICIPANT");
      attendee.setParameter("partstat", "NEEDS-ACTION");
      attendee.setParameter("rsvp", "TRUE");
      event.addProperty(attendee);
    }
  }
  stamp(root, event, commandId);
  const ical = root.toString() + "\r\n";
  calendarUid(ical, participants ? "scheduling" : true);
  return ical;
}
export function patchCalendarObject(
  ical: string,
  raw: unknown,
  commandId: string,
) {
  calendarUid(ical, true);
  const patch = CalendarPatch.parse(raw);
  const root = new ICAL.Component(ICAL.parse(ical));
  const events = root.getAllSubcomponents("vevent");
  const masters = events.filter((e) => !e.hasProperty("recurrence-id"));
  if (masters.length !== 1)
    throw new BadRequestException("日程没有唯一的系列主事件，无法修改。");
  if (
    patch.interval &&
    (events.length > 1 ||
      masters[0]!.hasProperty("rrule") ||
      masters[0]!.hasProperty("rdate") ||
      masters[0]!.hasProperty("exdate"))
  )
    throw new BadRequestException(
      "重复日程的时间调整须通过重复规则与例外编辑入口完成。",
    );
  for (const event of events) {
    editFields(root, event, patch);
    bumpSequence(event);
    stamp(root, event, commandId);
  }
  const changed = root.toString() + "\r\n";
  calendarUid(changed, true);
  return changed;
}

export function readCalendarSeriesRule(
  ical: string,
  scheduling = false,
): CalendarSeriesRule {
  calendarUid(ical, scheduling ? "scheduling" : true);
  const master = meetingMaster(ical);
  const rules = master
    .getAllProperties("rrule")
    .map((property) => property.getFirstValue());
  if (!rules.length || rules.some((rule) => !(rule instanceof ICAL.Recur)))
    throw new BadRequestException("来源没有可调整的 RRULE 系列。");
  const rule = rules.length === 1 ? rules[0] : null;
  const parsed =
    rule instanceof ICAL.Recur && !rule.until && !Object.keys(rule.parts).length
      ? CalendarRepeat.safeParse({
          frequency: rule.freq,
          count: rule.count,
          interval: rule.interval,
        })
      : null;
  return {
    rules: rules.map(String),
    simple: parsed?.success ? parsed.data : null,
    exceptionCount:
      master.parent!.getAllSubcomponents("vevent").length -
      1 +
      master.getAllProperties("exdate").flatMap((p) => p.getValues()).length,
  };
}

export function patchCalendarSeriesRule(
  ical: string,
  repeat: CalendarRepeat | null,
  commandId: string,
) {
  calendarUid(ical, true);
  const master = meetingMaster(ical);
  const root = master.parent!;
  if (!master.hasProperty("rrule") || master.hasProperty("exrule"))
    throw new BadRequestException("此来源系列的规则须在来源日历中调整。");
  const overrides = root
    .getAllSubcomponents("vevent")
    .filter((event) => event !== master);
  if (
    overrides.some((event) =>
      event.getFirstProperty("recurrence-id")?.getParameter("range"),
    )
  )
    throw new BadRequestException("含范围例外的规则须在来源日历中调整。");
  const additions = master
    .getAllProperties("rdate")
    .flatMap((p) => p.getValues());
  const exceptions = [
    ...master.getAllProperties("exdate").flatMap((p) => p.getValues()),
    ...overrides.map((event) => event.getFirstPropertyValue("recurrence-id")),
  ];
  if (!repeat) {
    if (additions.length || exceptions.length)
      throw new ConflictException(
        "请先处理已有单次例外和附加日期，再取消整组重复。",
      );
    master.removeAllProperties("rrule");
  } else {
    const event = new ICAL.Event(master);
    const start = event.startDate,
      end = event.endDate;
    if (
      !start ||
      !end ||
      start.isDate !== end.isDate ||
      (!start.isDate &&
        (start.zone.tzid === "floating" || end.zone.tzid === "floating"))
    )
      throw new BadRequestException("无法核实系列的起止时间与来源时区。");
    const zone = start.zone;
    const sourceInterval = CalendarInterval.parse(
      start.isDate
        ? { kind: "all_day", start: start.toString(), end: end.toString() }
        : zone === ICAL.Timezone.utcTimezone
          ? {
              kind: "timed",
              start: start.toString(),
              end: end.convertToZone(zone).toString(),
            }
          : {
              kind: "zoned",
              start: start.toString(),
              end: end.convertToZone(zone).toString(),
              timeZone: zone.tzid,
            },
    );
    const { rule } = recurrenceHorizon(sourceInterval, repeat);
    const allowed = new Set([recurrenceKey(start)]);
    const iter = rule!.iterator(start);
    for (let i = 0; i < repeat.count; i++) {
      const occurrence = iter.next();
      if (!occurrence)
        throw new BadRequestException("新规则没有足够的有效日期。");
      if (sourceInterval.kind === "zoned") {
        const instant = Temporal.PlainDateTime.from(
          occurrence.toString(),
        ).toZonedDateTime(sourceInterval.timeZone, {
          disambiguation: "reject",
        }).epochMilliseconds;
        if (instant !== occurrence.toUnixTime() * 1000)
          throw new ConflictException(
            "来源时区定义未覆盖新规则，请在来源日历扩展时区定义。",
          );
      }
      allowed.add(recurrenceKey(occurrence));
    }
    for (const entry of additions) {
      const time = entry instanceof ICAL.Period ? entry.start : entry;
      if (
        !(time instanceof ICAL.Time) ||
        time.isDate !== start.isDate ||
        (!time.isDate && time.zone.tzid === "floating")
      )
        throw new ConflictException("附加日期的来源时间无法核实。");
      allowed.add(recurrenceKey(time));
    }
    for (const value of exceptions) {
      if (
        !(value instanceof ICAL.Time) ||
        value.isDate !== start.isDate ||
        (!value.isDate && value.zone.tzid === "floating") ||
        !allowed.has(recurrenceKey(value))
      )
        throw new ConflictException(
          "新规则会使已有单次例外失去原实例，请先处理这些例外。",
        );
    }
    master.removeAllProperties("rrule");
    master.updatePropertyWithValue("rrule", rule!);
  }
  bumpSequence(master);
  stamp(root, master, commandId);
  const changed = root.toString() + "\r\n";
  calendarUid(changed, true);
  return changed;
}

type OccurrenceCommand = Extract<
  CalendarCommandInput,
  { operation: "update"; scope: "occurrence" }
>;

function recurrenceKey(time: InstanceType<typeof ICAL.Time>) {
  if (time.isDate || time.zone.tzid === "floating") return time.toString();
  return time.convertToZone(ICAL.Timezone.utcTimezone).toString();
}

/** Only use an occurrence verified against the same source object and ETag.
 * Preserve the original recurrence key even after an occurrence has moved. */
export function patchCalendarOccurrence(
  ical: string,
  occurrence: CalendarOccurrence,
  change: OccurrenceCommand["change"],
  commandId: string,
) {
  const uid = calendarUid(ical, true);
  if (
    uid !== occurrence.uid ||
    !occurrence.recurrenceId ||
    occurrence.status === "cancelled"
  )
    throw new BadRequestException("无法核实本次重复日程。");
  const root = new ICAL.Component(ICAL.parse(ical));
  const events = root.getAllSubcomponents("vevent");
  const masters = events.filter((event) => !event.hasProperty("recurrence-id"));
  const master = masters[0];
  if (
    masters.length !== 1 ||
    !master ||
    !(master.hasProperty("rrule") || master.hasProperty("rdate")) ||
    events.some((event) =>
      event.getFirstProperty("recurrence-id")?.getParameter("range"),
    )
  )
    throw new BadRequestException("此重复规则需要在来源日历中处理。");
  const originalStart = master.getFirstPropertyValue("dtstart");
  const expandedKey = ICAL.Time.fromString(occurrence.recurrenceId, undefined);
  if (
    !(originalStart instanceof ICAL.Time) ||
    expandedKey.isDate !== originalStart.isDate ||
    (!expandedKey.isDate &&
      (expandedKey.zone.tzid === "floating" ||
        originalStart.zone.tzid === "floating"))
  )
    throw new BadRequestException("来源未给出可核实的重复日程时区。");
  const key = expandedKey.isDate
    ? expandedKey
    : expandedKey.convertToZone(originalStart.zone);
  const originalKey = recurrenceKey(expandedKey);
  if (recurrenceKey(key) !== originalKey)
    throw new BadRequestException(
      "本次重复日程落在无法唯一标记的时区切换时间。",
    );
  const existing = events.filter((event) => {
    if (event === master) return false;
    const value = event.getFirstPropertyValue("recurrence-id");
    if (
      !(value instanceof ICAL.Time) ||
      value.isDate !== key.isDate ||
      (!value.isDate && value.zone.tzid === "floating")
    )
      throw new BadRequestException("来源例外的原始日期或时区无法核实。");
    return recurrenceKey(value) === originalKey;
  });
  if (existing.length > 1)
    throw new BadRequestException("来源存在多个相同日程例外。");
  const current = existing[0];
  const keyProperty = (name: "recurrence-id" | "exdate") => {
    const property = new ICAL.Property(name);
    property.setValue(key);
    if (!key.isDate && key.zone !== ICAL.Timezone.utcTimezone)
      property.setParameter("tzid", key.zone.tzid);
    return property;
  };

  if (change.operation === "cancel") {
    if (current) root.removeSubcomponent(current);
    const excluded = master
      .getAllProperties("exdate")
      .some((property) =>
        property
          .getValues()
          .some(
            (value) =>
              value instanceof ICAL.Time &&
              recurrenceKey(value) === originalKey,
          ),
      );
    if (!excluded) master.addProperty(keyProperty("exdate"));
    bumpSequence(master);
    stamp(root, master, commandId);
  } else {
    if (
      change.patch.interval &&
      (change.patch.interval.kind === "all_day") !== key.isDate
    )
      throw new BadRequestException("本次修改须保留日程的全天或定时类型。");
    let exception = current;
    if (!exception) {
      exception = new ICAL.Component(structuredClone(master.toJSON()));
      for (const field of ["rrule", "rdate", "exdate", "exrule"])
        exception.removeAllProperties(field);
      const { start, end } = occurrence;
      if (start.kind === "date" && end.kind === "date")
        interval(root, exception, {
          kind: "all_day",
          start: start.value,
          end: end.value,
        });
      else if (start.kind === "instant" && end.kind === "instant")
        interval(root, exception, {
          kind: "timed",
          start: start.value,
          end: end.value,
        });
      else throw new BadRequestException("本次日程的开始或结束时间无法核实。");
      exception.addProperty(keyProperty("recurrence-id"));
      root.addSubcomponent(exception);
    }
    editFields(root, exception, change.patch);
    bumpSequence(exception);
    stamp(root, exception, commandId);
  }
  const changed = root.toString() + "\r\n";
  calendarUid(changed, true);
  return changed;
}

/** Exact semantic comparison, allowing property order/folding and known source timestamps.
 * Any other source change leaves an unknown outcome rather than fabricating success. */
export function calendarObjectDigest(ical: string, scheduling = false) {
  calendarUid(ical);
  const normalize = (value: any): any => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, normalize(v)]),
      );
    return value;
  };
  const component = (node: any): any => [
    node[0],
    node[1]
      .filter(
        (p: any) =>
          !["dtstamp", "last-modified", "created", "prodid"].includes(p[0]),
      )
      .map((property: any) => {
        const normalized = normalize(property);
        if (scheduling && ["attendee", "organizer"].includes(normalized[0])) {
          delete normalized[1]["schedule-status"];
          if (normalized[0] === "attendee") {
            delete normalized[1].partstat;
            // The scheduling source can clear the request flag after a reply.
            delete normalized[1].rsvp;
          }
        }
        return normalized;
      })
      .sort((a: any, b: any) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
    node[2]
      .map(component)
      .sort((a: any, b: any) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      ),
  ];
  return stableDigest(component(ICAL.parse(ical)));
}

export function calendarCommandMarker(ical: string) {
  return new ICAL.Component(ICAL.parse(ical)).getFirstPropertyValue(
    "x-hyper-command-id",
  );
}

function meetingMaster(ical: string) {
  calendarUid(ical);
  const events = new ICAL.Component(ICAL.parse(ical)).getAllSubcomponents(
    "vevent",
  );
  const masters = events.filter((event) => !event.hasProperty("recurrence-id"));
  if (masters.length !== 1)
    throw new BadRequestException("来源会议缺少唯一主日程。");
  return masters[0]!;
}

export function meetingParticipants(ical: string) {
  const master = meetingMaster(ical);
  return {
    organizer: master.getFirstPropertyValue("organizer"),
    attendees: master
      .getAllProperties("attendee")
      .map((p) => p.getFirstValue()),
  };
}

export function invitationStatuses(
  expectedIcal: string,
  actualIcal: string,
  uids: string[],
): CalendarInvitationStatus[] {
  const expected = meetingParticipants(expectedIcal).attendees;
  const actual = meetingMaster(actualIcal).getAllProperties("attendee");
  if (expected.length !== uids.length)
    throw new Error("Invitation employee binding mismatch");
  return uids.map((employeeUid, index) => {
    const participant = actual.find(
      (p) => p.getFirstValue() === expected[index],
    );
    const code = String(
      participant?.getParameter("schedule-status") ?? "",
    ).match(/^([1-5]\.\d+)(?:;|$)/u)?.[1];
    const status = participant?.getParameter("partstat");
    const instances = meetingResponses(
      meetingMaster(actualIcal),
      String(expected[index]),
    ).filter(
      (
        entry,
      ): entry is {
        recurrenceId: string;
        response: CalendarInvitationStatus["response"];
      } => entry.recurrenceId !== null,
    );
    return {
      employeeUid,
      delivery:
        code === "1.2"
          ? "delivered"
          : code === "1.1" || code === "1.0"
            ? "pending"
            : code?.startsWith("3.") || code?.startsWith("5.")
              ? "rejected"
              : "unreported",
      response: participantResponse(status),
      ...(instances.length ? { instances } : {}),
    };
  });
}

function participantResponse(
  value: unknown,
): CalendarInvitationStatus["response"] {
  if (value === "ACCEPTED") return "accepted";
  if (value === "TENTATIVE") return "tentative";
  if (value === "DECLINED") return "declined";
  return value === "NEEDS-ACTION" ? "needs_action" : "unreported";
}

export function calendarMeeting(
  ical: string,
  address: string,
  occurrence?: CalendarOccurrence,
): CalendarMeeting {
  const master = meetingMaster(ical);
  const organizers = master.getAllProperties("organizer");
  const participants = master.getAllProperties("attendee");
  if (organizers.length !== 1 || !participants.length)
    throw new BadRequestException("来源日程没有完整的会议身份。");
  const role =
    organizers[0]!.getFirstValue() === address ? "organizer" : "attendee";
  const own = participants.filter((p) => p.getFirstValue() === address);
  if (role === "attendee" && own.length !== 1)
    throw new BadRequestException("当前员工不是可核实的会议参会人。");
  const events = master.parent!.getAllSubcomponents("vevent");
  const responses =
    role === "attendee" ? meetingResponses(master, address) : undefined;
  let selectedResponse: CalendarInvitationStatus["response"] | undefined;
  if (occurrence && role === "attendee") {
    const { current } = meetingOccurrence(master, occurrence, true);
    const selected = (current ?? master)
      .getAllProperties("attendee")
      .filter((p) => p.getFirstValue() === address);
    if (selected.length !== 1)
      throw new BadRequestException("当前员工未被邀请参加本次会议。");
    selectedResponse = participantResponse(
      selected[0]!.getParameter("partstat"),
    );
  }
  let series: CalendarMeeting["series"];
  if (master.hasProperty("rrule")) {
    try {
      const rule = readCalendarSeriesRule(ical, true);
      if (rule.simple) {
        const value = sourceInterval(master);
        series = {
          interval: value,
          repeat: rule.simple,
          exceptionCount: rule.exceptionCount,
          canReschedule:
            !master.hasProperty("exrule") &&
            !events.some((event) =>
              event.getFirstProperty("recurrence-id")?.getParameter("range"),
            ),
        };
      }
    } catch {
      /* Unresolved source rules remain readable, with no reschedule capability. */
    }
  }
  return {
    role,
    cancelled: master.getFirstPropertyValue("status") === "CANCELLED",
    title: String(master.getFirstPropertyValue("summary") ?? "会议").slice(
      0,
      500,
    ),
    ...(role === "attendee"
      ? { ownResponse: participantResponse(own[0]!.getParameter("partstat")) }
      : {}),
    ...(responses ? { responses } : {}),
    ...(selectedResponse
      ? { selectedResponse, selectedRecurrenceId: occurrence!.recurrenceId! }
      : {}),
    ...(series ? { series } : {}),
  };
}

function sourceInterval(component: Component): CalendarInterval {
  const event = new ICAL.Event(component),
    start = event.startDate,
    end = event.endDate;
  if (
    !start ||
    !end ||
    start.isDate !== end.isDate ||
    (!start.isDate &&
      (start.zone.tzid === "floating" || end.zone.tzid === "floating"))
  )
    throw new BadRequestException("无法核实系列的起止时间与来源时区。");
  return CalendarInterval.parse(
    start.isDate
      ? { kind: "all_day", start: start.toString(), end: end.toString() }
      : start.zone === ICAL.Timezone.utcTimezone
        ? {
            kind: "timed",
            start: start.toString(),
            end: end.convertToZone(start.zone).toString(),
          }
        : {
            kind: "zoned",
            start: start.toString(),
            end: end.convertToZone(start.zone).toString(),
            timeZone: start.zone.tzid,
          },
  );
}

function meetingResponses(master: Component, address: string) {
  const responses: NonNullable<CalendarMeeting["responses"]> = [];
  const keys = new Set<string>();
  for (const event of master.parent!.getAllSubcomponents("vevent")) {
    const value = event.getFirstPropertyValue("recurrence-id");
    if (
      event !== master &&
      (!(value instanceof ICAL.Time) ||
        (!value.isDate && value.zone.tzid === "floating"))
    )
      throw new BadRequestException("来源例外的原始日期或时区无法核实。");
    const key = value instanceof ICAL.Time ? recurrenceKey(value) : null;
    if (keys.has(key ?? "master"))
      throw new BadRequestException("来源存在多个相同日程例外。");
    keys.add(key ?? "master");
    const own = event
      .getAllProperties("attendee")
      .filter((p) => p.getFirstValue() === address);
    if (own.length > 1)
      throw new BadRequestException("来源参会身份重复，无法核实回复。");
    if (own.length === 1)
      responses.push({
        recurrenceId: key,
        response: participantResponse(own[0]!.getParameter("partstat")),
      });
  }
  return responses.sort((a, b) =>
    (a.recurrenceId ?? "").localeCompare(b.recurrenceId ?? ""),
  );
}

/** The scheduling digest intentionally ignores PARTSTAT. Compare every own response separately. */
export function calendarMeetingRepliesMatch(
  expected: string,
  actual: string,
  address: string,
) {
  return (
    JSON.stringify(meetingResponses(meetingMaster(expected), address)) ===
    JSON.stringify(meetingResponses(meetingMaster(actual), address))
  );
}

/** occurrence must come from a bounded expansion of this exact UID and ETag. */
function meetingOccurrence(
  master: Component,
  occurrence: CalendarOccurrence,
  allowCancelled = false,
) {
  if (
    occurrence.uid !== master.getFirstPropertyValue("uid") ||
    !occurrence.recurrenceId ||
    (occurrence.status === "cancelled" && !allowCancelled) ||
    !(master.hasProperty("rrule") || master.hasProperty("rdate"))
  )
    throw new BadRequestException("无法核实本次会议实例。");
  const events = master.parent!.getAllSubcomponents("vevent");
  if (
    events.some((event) =>
      event.getFirstProperty("recurrence-id")?.getParameter("range"),
    )
  )
    throw new BadRequestException("含范围例外的会议须在来源日历中回复。");
  const start = master.getFirstPropertyValue("dtstart");
  const expanded = ICAL.Time.fromString(occurrence.recurrenceId, undefined);
  if (
    !(start instanceof ICAL.Time) ||
    start.isDate !== expanded.isDate ||
    (!start.isDate &&
      (start.zone.tzid === "floating" || expanded.zone.tzid === "floating"))
  )
    throw new BadRequestException("本次会议的来源时区无法核实。");
  const key = expanded.isDate ? expanded : expanded.convertToZone(start.zone);
  if (recurrenceKey(key) !== recurrenceKey(expanded))
    throw new BadRequestException("本次会议时区不能唯一定位。");
  const matches = events.filter((event) => {
    if (event === master) return false;
    const value = event.getFirstPropertyValue("recurrence-id");
    if (
      !(value instanceof ICAL.Time) ||
      value.isDate !== key.isDate ||
      (!value.isDate && value.zone.tzid === "floating")
    )
      throw new BadRequestException("来源例外的原始日期或时区无法核实。");
    return recurrenceKey(value) === recurrenceKey(key);
  });
  if (matches.length > 1)
    throw new BadRequestException("来源存在多个相同会议例外。");
  if (
    !allowCancelled &&
    matches[0]?.getFirstPropertyValue("status") === "CANCELLED"
  )
    throw new BadRequestException("本次会议已经取消。");
  return { key, current: matches[0] };
}

function setTimeProperty(
  component: Component,
  name: string,
  time: InstanceType<typeof ICAL.Time>,
) {
  const property = new ICAL.Property(name);
  property.setValue(time);
  if (!time.isDate && time.zone !== ICAL.Timezone.utcTimezone)
    property.setParameter("tzid", time.zone.tzid);
  component.addProperty(property);
}

function rescheduleMeeting(
  master: Component,
  value: CalendarInterval,
  commandId: string,
) {
  const root = master.parent!,
    raw = root.toString(),
    rule = readCalendarSeriesRule(raw, true),
    previous = sourceInterval(master);
  if (!rule.simple || master.hasProperty("exrule"))
    throw new BadRequestException("此来源重复规则须在来源日历中改期。");
  if (
    value.kind !== previous.kind ||
    (value.kind === "zoned" &&
      previous.kind === "zoned" &&
      value.timeZone !== previous.timeZone)
  )
    throw new BadRequestException("整组改期须保留全天类型与原系列时区。");
  if (value.start === previous.start && value.end === previous.end)
    throw new BadRequestException("请修改系列首次时间后再确认改期。");
  const events = root.getAllSubcomponents("vevent");
  if (
    events.some((event) =>
      event.getFirstProperty("recurrence-id")?.getParameter("range"),
    )
  )
    throw new BadRequestException("含范围例外的会议须在来源日历中改期。");
  const enumerate = (component: Component, range: CalendarInterval) => {
    const bound = recurrenceHorizon(range, rule.simple!),
      start = new ICAL.Event(component).startDate;
    const iterator = bound.rule!.iterator(start),
      times: InstanceType<typeof ICAL.Time>[] = [];
    for (let i = 0; i < rule.simple!.count; i++) {
      const time = iterator.next();
      if (!time) throw new BadRequestException("来源重复规则无法完整展开。");
      if (
        range.kind === "zoned" &&
        Temporal.PlainDateTime.from(time.toString()).toZonedDateTime(
          range.timeZone,
          { disambiguation: "reject" },
        ).epochMilliseconds !==
          time.toUnixTime() * 1000
      )
        throw new ConflictException(
          "来源时区定义未覆盖整组改期，请先在来源日历更新时区。",
        );
      times.push(time.clone());
    }
    return times;
  };
  const oldTimes = enumerate(master, previous);
  const oldDuration = new ICAL.Event(master).duration;
  interval(root, master, value, rule.simple);
  const newTimes = enumerate(master, value);
  const newDuration = new ICAL.Event(master).duration;
  const oldByKey = new Map(oldTimes.map((time) => [recurrenceKey(time), time]));
  const mapping = new Map(
    oldTimes.map((time, index) => [recurrenceKey(time), newTimes[index]!]),
  );
  const destinationKeys = new Set(newTimes.map(recurrenceKey));
  if (
    mapping.size !== oldTimes.length ||
    destinationKeys.size !== newTimes.length
  )
    throw new ConflictException("整组改期不能合并不同实例。");
  // Explicit additional dates stay literal; reject overlap instead of silently merging instances.
  for (const property of master.getAllProperties("rdate"))
    for (const entry of property.getValues()) {
      const time = entry instanceof ICAL.Period ? entry.start : entry;
      if (
        !(time instanceof ICAL.Time) ||
        time.isDate !== newTimes[0]!.isDate ||
        (!time.isDate && time.zone.tzid === "floating") ||
        mapping.has(recurrenceKey(time)) ||
        destinationKeys.has(recurrenceKey(time))
      )
        throw new ConflictException(
          "附加日期与整组改期冲突，请先在来源日历处理。",
        );
      mapping.set(recurrenceKey(time), time);
      destinationKeys.add(recurrenceKey(time));
    }
  const mapped = (value: unknown) => {
    const time =
      value instanceof ICAL.Time && mapping.get(recurrenceKey(value));
    if (!time) throw new ConflictException("整组改期会丢失已有单次例外。");
    return time;
  };
  const excluded = master
    .getAllProperties("exdate")
    .flatMap((p) => p.getValues())
    .map(mapped);
  master.removeAllProperties("exdate");
  for (const time of excluded) setTimeProperty(master, "exdate", time);
  const overrideKeys = new Set<string>();
  const resetParticipants = (event: Component) => {
    for (const attendee of event.getAllProperties("attendee"))
      if (attendee.getFirstValue() !== organizerAddress) {
        attendee.setParameter("partstat", "NEEDS-ACTION");
        attendee.setParameter("rsvp", "TRUE");
      }
  };
  const organizerAddress = master.getFirstPropertyValue("organizer");
  for (const event of events)
    if (event !== master) {
      const oldKey = event.getFirstPropertyValue("recurrence-id");
      const time = mapped(oldKey),
        key = recurrenceKey(time);
      if (overrideKeys.has(key))
        throw new ConflictException("来源存在重复的单次例外。");
      overrideKeys.add(key);
      // A reply/text-only override is still on the ordinary series interval. Move it
      // with the series; only an independently arranged interval stays literal.
      const oldTime =
        oldKey instanceof ICAL.Time
          ? oldByKey.get(recurrenceKey(oldKey))
          : undefined;
      const oldEnd = oldTime?.clone();
      oldEnd?.addDuration(oldDuration);
      const actual = new ICAL.Event(event);
      if (
        oldTime &&
        oldEnd &&
        recurrenceKey(actual.startDate) === recurrenceKey(oldTime) &&
        recurrenceKey(actual.endDate) === recurrenceKey(oldEnd)
      ) {
        const end = time.clone();
        end.addDuration(newDuration);
        for (const name of ["dtstart", "dtend", "duration"])
          event.removeAllProperties(name);
        setTimeProperty(event, "dtstart", time);
        setTimeProperty(event, "dtend", end);
        if (event.getFirstPropertyValue("status") !== "CANCELLED")
          resetParticipants(event);
      }
      event.removeAllProperties("recurrence-id");
      setTimeProperty(event, "recurrence-id", time);
      // Preserve the explicitly arranged exception interval and its actual participant state.
    }
  resetParticipants(master);
  for (const event of events) {
    bumpSequence(event);
    stamp(root, event, commandId);
  }
}

type MeetingCommand = Extract<
  CalendarCommandInput,
  { operation: "update"; scope: "meeting" }
>;
export function patchCalendarMeeting(
  ical: string,
  address: string,
  change: MeetingCommand["change"],
  commandId: string,
  occurrence?: CalendarOccurrence,
) {
  const meeting = calendarMeeting(ical, address);
  if (meeting.cancelled) throw new BadRequestException("会议已经取消。");
  const root = new ICAL.Component(ICAL.parse(ical));
  const events = root.getAllSubcomponents("vevent");
  const master = events.find((event) => !event.hasProperty("recurrence-id"))!;
  const organizer = master.getFirstPropertyValue("organizer");
  if (
    events.some(
      (event) =>
        event.getAllProperties("organizer").length !== 1 ||
        event.getFirstPropertyValue("organizer") !== organizer,
    )
  )
    throw new BadRequestException("来源会议例外的组织者身份无法核实。");
  if (change.operation === "reschedule_series") {
    if (meeting.role !== "organizer")
      throw new BadRequestException("只有来源会议组织者可以整组改期。");
    rescheduleMeeting(
      master,
      CalendarInterval.parse(change.interval),
      commandId,
    );
    const changed = root.toString() + "\r\n";
    calendarUid(changed, "scheduling");
    return changed;
  }
  let targets = events;
  if (change.operation === "reply") {
    if (meeting.role !== "attendee")
      throw new BadRequestException("仅可回复本人收到的会议邀请。");
    meetingResponses(master, address);
    if (
      events.some((event) =>
        event.getFirstProperty("recurrence-id")?.getParameter("range"),
      )
    )
      throw new BadRequestException("含范围例外的会议须在来源日历中回复。");
    if (change.target?.scope === "occurrence") {
      if (!occurrence || occurrence.recurrenceId !== change.target.recurrenceId)
        throw new BadRequestException("本次会议需先核对来源窗口。");
      const { key, current } = meetingOccurrence(master, occurrence);
      let exception = current;
      if (!exception) {
        exception = new ICAL.Component(structuredClone(master.toJSON()));
        for (const name of ["rrule", "rdate", "exdate", "exrule"])
          exception.removeAllProperties(name);
        if (occurrence.start.kind === "date" && occurrence.end.kind === "date")
          interval(root, exception, {
            kind: "all_day",
            start: occurrence.start.value,
            end: occurrence.end.value,
          });
        else if (
          occurrence.start.kind === "instant" &&
          occurrence.end.kind === "instant"
        )
          interval(root, exception, {
            kind: "timed",
            start: occurrence.start.value,
            end: occurrence.end.value,
          });
        else throw new BadRequestException("本次会议的时间无法核实。");
        setTimeProperty(exception, "recurrence-id", key);
        root.addSubcomponent(exception);
      }
      if (
        exception
          .getAllProperties("attendee")
          .filter((p) => p.getFirstValue() === address).length !== 1
      )
        throw new BadRequestException("当前员工未被邀请参加本次会议。");
      targets = [exception];
    } else
      targets = events.filter(
        (event) =>
          event.getFirstPropertyValue("status") !== "CANCELLED" &&
          event
            .getAllProperties("attendee")
            .some((p) => p.getFirstValue() === address),
      );
    if (
      !targets.some(
        (event) =>
          event
            .getAllProperties("attendee")
            .find((p) => p.getFirstValue() === address)!
            .getParameter("partstat") !== change.response,
      )
    )
      throw new BadRequestException("已保存相同参会回复。");
  }
  for (const event of targets) {
    if (change.operation !== "reply") {
      if (
        meeting.role !== "organizer" ||
        event.getFirstPropertyValue("organizer") !== address
      )
        throw new BadRequestException("只有来源会议组织者可以调整或取消会议。");
      if (change.operation === "cancel")
        event.updatePropertyWithValue("status", "CANCELLED");
      else {
        if (
          change.patch.interval &&
          (events.length > 1 ||
            event.hasProperty("rrule") ||
            event.hasProperty("rdate"))
        )
          throw new BadRequestException(
            "重复会议的时间需按系列或单次实例调整。",
          );
        editFields(root, event, change.patch);
      }
      bumpSequence(event);
    } else {
      const own = event
        .getAllProperties("attendee")
        .find((p) => p.getFirstValue() === address)!;
      own.setParameter("partstat", change.response);
      own.setParameter("rsvp", "FALSE");
    }
    stamp(root, event, commandId);
  }
  const changed = root.toString() + "\r\n";
  calendarUid(changed, "scheduling");
  return changed;
}

import { BadRequestException } from "@nestjs/common";
import ICAL from "ical.js";
import {
  CalendarDraft,
  CalendarPatch,
  type CalendarInterval,
  type CalendarCommandInput,
  type CalendarOccurrence,
  type CalendarRepeat,
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
  };
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
) {
  const meeting = calendarMeeting(ical, address);
  if (meeting.cancelled) throw new BadRequestException("会议已经取消。");
  const root = new ICAL.Component(ICAL.parse(ical));
  const events = root.getAllSubcomponents("vevent");
  for (const event of events) {
    if (change.operation === "cancel") {
      if (
        meeting.role !== "organizer" ||
        event.getFirstPropertyValue("organizer") !== address
      )
        throw new BadRequestException("只有来源会议组织者可以取消会议。");
      event.updatePropertyWithValue("status", "CANCELLED");
      bumpSequence(event);
    } else {
      if (meeting.role !== "attendee" || events.length !== 1)
        throw new BadRequestException(
          "仅可回复本人收到、没有单次例外的会议邀请。",
        );
      const own = event
        .getAllProperties("attendee")
        .find((p) => p.getFirstValue() === address)!;
      if (own.getParameter("partstat") === change.response)
        throw new BadRequestException("已保存相同参会回复。");
      own.setParameter("partstat", change.response);
      own.setParameter("rsvp", "FALSE");
    }
    stamp(root, event, commandId);
  }
  const changed = root.toString() + "\r\n";
  calendarUid(changed, "scheduling");
  return changed;
}

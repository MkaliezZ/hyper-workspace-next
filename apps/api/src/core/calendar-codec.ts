import { BadRequestException } from "@nestjs/common";
import ICAL from "ical.js";
import {
  CalendarDraft,
  CalendarPatch,
  type CalendarInterval,
} from "@hyper/contracts/calendar";
import { calendarUid } from "../providers/nextcloud-calendar.js";
import { stableDigest } from "./credentials.js";
type Component = InstanceType<typeof ICAL.Component>;

function interval(component: Component, value: CalendarInterval) {
  for (const name of ["dtstart", "dtend", "duration"])
    component.removeAllProperties(name);
  for (const [property, text] of [
    ["dtstart", value.start],
    ["dtend", value.end],
  ] as const) {
    const time = ICAL.Time.fromString(text, undefined);
    component.updatePropertyWithValue(property, time);
  }
}
function stamp(root: Component, event: Component, commandId: string) {
  root.updatePropertyWithValue("x-hyper-command-id", commandId);
  event.updatePropertyWithValue(
    "dtstamp",
    ICAL.Time.fromJSDate(new Date(), true),
  );
}
export function createCalendarObject(
  raw: CalendarDraft,
  uid: string,
  commandId: string,
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
  interval(event, draft.interval);
  stamp(root, event, commandId);
  const ical = root.toString() + "\r\n";
  calendarUid(ical, true);
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
    if (patch.title !== undefined)
      event.updatePropertyWithValue("summary", patch.title);
    if (patch.description !== undefined)
      event.updatePropertyWithValue("description", patch.description);
    if (patch.location !== undefined)
      event.updatePropertyWithValue("location", patch.location);
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
    if (patch.interval) interval(event, patch.interval);
    stamp(root, event, commandId);
  }
  const changed = root.toString() + "\r\n";
  calendarUid(changed, true);
  return changed;
}

/** Exact semantic comparison, allowing property order/folding and known source timestamps.
 * Any other source change leaves an unknown outcome rather than fabricating success. */
export function calendarObjectDigest(ical: string) {
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
      .map(normalize)
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

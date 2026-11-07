import { ServiceUnavailableException } from "@nestjs/common";
import ICAL from "ical.js";
import type { ExpandedCalendarObject } from "../providers/calendar.js";
import { calendarUid } from "../providers/nextcloud-calendar.js";

import type {
  CalendarPoint,
  CalendarOccurrence,
} from "@hyper/contracts/calendar";
export type {
  CalendarPoint,
  CalendarOccurrence,
} from "@hyper/contracts/calendar";

type Time = InstanceType<typeof ICAL.Time>;
type Component = InstanceType<typeof ICAL.Component>;

/** Don't coerce floating times or a missing source timezone into the host's timezone. */
function point(
  time: Time,
  component: Component,
  propertyName: string,
): CalendarPoint {
  if (time.isDate) return { kind: "date", value: time.toString() };
  const declared =
    component.getFirstProperty(propertyName)?.getParameter("tzid") ??
    component.getFirstProperty("dtstart")?.getParameter("tzid");
  const zone = time.zone.tzid;
  if (zone === "floating") {
    return typeof declared === "string" && declared
      ? {
          kind: "unresolved_timezone",
          value: time.toString(),
          timeZone: declared,
        }
      : { kind: "floating", value: time.toString() };
  }
  return {
    kind: "instant",
    value: time.toJSDate().toISOString(),
    timeZone: zone,
  };
}

/** Transform bounded, source-expanded instances for display. Never use this view to overwrite
 * a recurring source master. Busy-time calculation must resolve date/floating points first. */
export function calendarOccurrences(
  objects: ExpandedCalendarObject[],
): CalendarOccurrence[] {
  const result: CalendarOccurrence[] = [];
  try {
    for (const object of objects) {
      if (
        object.representation !== "expanded" ||
        calendarUid(object.ical) !== object.uid
      )
        throw new Error("Invalid expanded identity");
      const root = new ICAL.Component(ICAL.parse(object.ical));
      const components = root.getAllSubcomponents("vevent");
      if (result.length + components.length > 1000)
        throw new Error("Too many occurrences");
      const seen = new Set<string>();
      for (const component of components) {
        if (
          component.hasProperty("rrule") ||
          component.hasProperty("rdate") ||
          component.hasProperty("exdate")
        )
          throw new Error("Source didn't expand recurrence");
        const event = new ICAL.Event(component);
        if (
          !event.startDate ||
          !event.endDate ||
          event.endDate.compare(event.startDate) < 0 ||
          event.endDate.isDate !== event.startDate.isDate
        )
          throw new Error("Invalid event interval");
        const recurrenceId =
          component
            .getFirstProperty("recurrence-id")
            ?.getFirstValue()
            ?.toString() ?? null;
        if (seen.has(recurrenceId ?? "master"))
          throw new Error("Duplicate occurrence");
        seen.add(recurrenceId ?? "master");
        const truncatedFields: string[] = [];
        const text = (name: string, max: number) => {
          const value = component.getFirstPropertyValue(name);
          if (value === null) return "";
          if (typeof value !== "string" || value.includes("\u0000"))
            throw new Error("Invalid event text");
          const characters = Array.from(value);
          if (characters.length > max) truncatedFields.push(name);
          return characters.slice(0, max).join("");
        };
        const status = component.getFirstPropertyValue("status");
        const transparency = component.getFirstPropertyValue("transp");
        result.push({
          calendarId: object.calendarId,
          objectId: object.objectId,
          etag: object.etag,
          uid: object.uid,
          recurrenceId,
          ...(component.hasProperty("organizer") &&
          component.hasProperty("attendee")
            ? { meeting: true as const }
            : {}),
          title: text("summary", 500),
          description: text("description", 10000),
          location: text("location", 1000),
          start: point(event.startDate, component, "dtstart"),
          end: point(event.endDate, component, "dtend"),
          status:
            status === "TENTATIVE"
              ? "tentative"
              : status === "CONFIRMED"
                ? "confirmed"
                : status === "CANCELLED"
                  ? "cancelled"
                  : "unspecified",
          transparency:
            transparency === "TRANSPARENT" ? "transparent" : "opaque",
          truncatedFields,
        });
      }
    }
    return result;
  } catch {
    throw new ServiceUnavailableException(
      "日程实例不完整或来源未可靠展开，未使用部分结果计算排期。",
    );
  }
}

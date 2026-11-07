import ICAL from "ical.js";
import { Temporal } from "@js-temporal/polyfill";

/** Expanded CalDAV data may already have converted floating times to UTC using a
 * server default. Inspect the original before trusting those instants for scheduling. */
export function calendarTimeBasis(ical: string, sourceZoneDefined: boolean) {
  const root = new ICAL.Component(ICAL.parse(ical));
  let floating = false;
  for (const event of root.getAllSubcomponents("vevent")) {
    if (
      event.getFirstPropertyValue("status") === "CANCELLED" ||
      event.getFirstPropertyValue("transp") === "TRANSPARENT"
    )
      continue;
    for (const name of ["dtstart", "dtend", "recurrence-id", "rdate", "exdate"])
      for (const property of event.getAllProperties(name)) {
        for (const value of property.getValues()) {
          const times =
            value instanceof ICAL.Period ? [value.start, value.end] : [value];
          for (const time of times) {
            if (
              !time ||
              typeof time !== "object" ||
              !("zone" in time) ||
              !("isDate" in time)
            )
              continue;
            if (time.isDate || time.zone?.tzid !== "floating") continue;
            const declared = property.getParameter("tzid");
            if (typeof declared === "string") {
              try {
                Temporal.PlainDateTime.from(time.toString()).toZonedDateTime(
                  declared,
                );
                continue;
              } catch {
                return "unresolved_named_timezone" as const;
              }
            }
            floating = true;
          }
        }
      }
  }
  return floating
    ? sourceZoneDefined
      ? ("source_calendar_timezone" as const)
      : ("unresolved_source_timezone" as const)
    : ("explicit" as const);
}

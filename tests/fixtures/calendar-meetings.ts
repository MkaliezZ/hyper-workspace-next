import ICAL from "ical.js";

/** Bounded synthetic REPORT expansion; real scheduling is tested separately in Nextcloud. */
export function expandMeetingFixture(ical: string) {
  const root = new ICAL.Component(ICAL.parse(ical));
  const master = root
    .getAllSubcomponents("vevent")
    .find((event) => !event.hasProperty("recurrence-id"));
  if (!master?.hasProperty("rrule")) return ical;
  const event = new ICAL.Event(master),
    iterator = event.iterator();
  const expanded = new ICAL.Component(structuredClone(root.toJSON()));
  expanded.removeAllSubcomponents("vevent");
  for (let count = 0; count < 104; count++) {
    const key = iterator.next();
    if (!key) return expanded.toString() + "\r\n";
    const details = event.getOccurrenceDetails(key);
    const component = new ICAL.Component(
      structuredClone(details.item.component.toJSON()),
    );
    for (const name of [
      "rrule",
      "rdate",
      "exdate",
      "exrule",
      "dtstart",
      "dtend",
      "duration",
      "recurrence-id",
    ])
      component.removeAllProperties(name);
    for (const [name, time] of [
      ["dtstart", details.startDate],
      ["dtend", details.endDate],
      ["recurrence-id", key],
    ] as const)
      component.addPropertyWithValue(
        name,
        time.isDate ? time : time.convertToZone(ICAL.Timezone.utcTimezone),
      );
    expanded.addSubcomponent(component);
  }
  throw new Error("Fixture recurrence exceeds its bound");
}

/** Simulate a pre-existing special arrangement made in the organizer's source calendar. */
export function meetingOverride(
  ical: string,
  recurrenceId: string,
  start: string,
  end: string,
) {
  const root = new ICAL.Component(ICAL.parse(ical));
  const master = root
    .getAllSubcomponents("vevent")
    .find((event) => !event.hasProperty("recurrence-id"))!;
  const exception = new ICAL.Component(structuredClone(master.toJSON()));
  for (const name of [
    "rrule",
    "rdate",
    "exdate",
    "exrule",
    "dtstart",
    "dtend",
    "duration",
  ])
    exception.removeAllProperties(name);
  for (const [name, value] of [
    ["recurrence-id", recurrenceId],
    ["dtstart", start],
    ["dtend", end],
  ])
    exception.addPropertyWithValue(
      name!,
      ICAL.Time.fromString(value!, undefined),
    );
  root.addSubcomponent(exception);
  return root.toString() + "\r\n";
}

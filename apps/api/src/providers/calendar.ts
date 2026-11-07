/** Backend-only CalDAV boundary. Source data never grants a product/project permission. */
export interface SourceCalendar {
  /** Explicit source calendar timezone only. No server-default inference. */
  timeZone?: { id: string | null; revision: string };
  id: string;
  name: string;
  canRead: boolean;
  canCreate: boolean;
  canUpdate: boolean;
  canDelete: boolean;
}

export interface CalendarObject {
  calendarId: string;
  objectId: string;
  etag: string;
  /** Complete VCALENDAR including VTIMEZONE, recurring master and exceptions.
   * REPORT XML line endings are normalized back to iCalendar CRLF. */
  ical: string;
  uid: string;
}

export interface CalendarWindow {
  /** UTC RFC3339 instants; exclusive end. Bounded to at most 93 days. */
  start: string;
  end: string;
}

export interface ExpandedCalendarObject extends CalendarObject {
  /** Read representation only; editing must retrieve the original object first. */
  representation: "expanded";
}

export interface CalendarProvider {
  calendars(): Promise<SourceCalendar[]>;
  query(calendarId: string, window: CalendarWindow): Promise<CalendarObject[]>;
  occurrences(
    calendarId: string,
    window: CalendarWindow,
  ): Promise<ExpandedCalendarObject[]>;
  read(calendarId: string, objectId: string): Promise<CalendarObject>;
  create(calendarId: string, objectId: string, ical: string): Promise<void>;
  replace(
    calendarId: string,
    objectId: string,
    etag: string,
    ical: string,
  ): Promise<void>;
  remove(calendarId: string, objectId: string, etag: string): Promise<void>;
}

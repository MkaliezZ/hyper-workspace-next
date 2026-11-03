/** Backend-only CalDAV boundary. Source data never grants a product/project permission. */
export interface SourceCalendar {
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

export interface CalendarProvider {
  calendars(): Promise<SourceCalendar[]>;
  query(calendarId: string, window: CalendarWindow): Promise<CalendarObject[]>;
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

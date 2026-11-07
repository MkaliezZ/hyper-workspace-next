import { BadRequestException } from "@nestjs/common";
import { Temporal } from "@js-temporal/polyfill";
import ICAL from "ical.js";
import type {
  CalendarInterval,
  CalendarRepeat,
} from "@hyper/contracts/calendar";

type Component = InstanceType<typeof ICAL.Component>;
type WallInterval = Extract<CalendarInterval, { kind: "zoned" }>;

function localText(time: Temporal.PlainDateTime) {
  return time.toString({ smallestUnit: "second" });
}

function resolveWallTime(value: Temporal.PlainDateTime, zone: string) {
  try {
    return value.toZonedDateTime(zone, { disambiguation: "reject" });
  } catch {
    throw new BadRequestException(
      `所选时区的日程时间 ${localText(value)} 不存在，或在夏令时切换时出现两次。`,
    );
  }
}

/** Bound the generated source rules and capture timezone transitions for the series' lifetime. */
export function recurrenceHorizon(
  value: CalendarInterval,
  repeat?: CalendarRepeat,
) {
  const start = value.start.replace(/Z$/u, "");
  const end = value.end.replace(/Z$/u, "");
  const startDate = Temporal.PlainDate.from(start.slice(0, 10));
  const limit = startDate.add({ years: 5 });
  const endDate = Temporal.PlainDate.from(end.slice(0, 10));
  const rule = repeat
    ? new ICAL.Recur({
        freq: repeat.frequency,
        interval: repeat.interval,
        count: repeat.count,
      })
    : null;
  let last = startDate;
  if (rule && repeat) {
    const occurrences = rule.iterator(ICAL.Time.fromString(start, undefined));
    const wallDuration =
      value.kind === "zoned"
        ? Temporal.PlainDateTime.from(start).until(
            Temporal.PlainDateTime.from(end),
          )
        : null;
    for (let i = 0; i < repeat.count; i++) {
      const occurrence = occurrences.next();
      if (!occurrence)
        throw new BadRequestException("重复规则没有足够的有效日期。");
      last = Temporal.PlainDate.from(occurrence.toString().slice(0, 10));
      if (Temporal.PlainDate.compare(last, limit) > 0)
        throw new BadRequestException("重复日程须在五年内结束。");
      if (value.kind === "zoned" && wallDuration) {
        const wallStart = Temporal.PlainDateTime.from(occurrence.toString());
        resolveWallTime(wallStart, value.timeZone);
        resolveWallTime(wallStart.add(wallDuration), value.timeZone);
      }
    }
  }
  const horizon = last.add({ days: startDate.until(endDate).days });
  if (Temporal.PlainDate.compare(horizon, limit) > 0)
    throw new BadRequestException("日程结束时间须在五年内。");
  return { rule, horizon };
}

export function zonedCalendarTimes(
  root: Component,
  value: WallInterval,
  horizon: Temporal.PlainDate,
) {
  const times = [value.start, value.end].map((text) =>
    resolveWallTime(Temporal.PlainDateTime.from(text), value.timeZone),
  );
  if (Temporal.ZonedDateTime.compare(times[0]!, times[1]!) >= 0)
    throw new BadRequestException("结束时间须晚于开始时间。");
  const zoneId = times[0]!.timeZoneId;
  if (zoneId === "UTC")
    return times.map((time) =>
      ICAL.Time.fromString(time.toInstant().toString(), undefined),
    );
  const existing = root
    .getAllSubcomponents("vtimezone")
    .find((zone) => zone.getFirstPropertyValue("tzid") === zoneId);
  if (!existing) {
    const zone = new ICAL.Component("vtimezone");
    zone.updatePropertyWithValue("tzid", zoneId);
    const first = Temporal.PlainDate.from(value.start.slice(0, 10))
      .subtract({ years: 1 })
      .toZonedDateTime(zoneId);
    const last = horizon.add({ years: 1 }).toZonedDateTime(zoneId);
    const observance = (
      wall: Temporal.PlainDateTime,
      from: string,
      to: string,
    ) => {
      if (!/^[+-]\d{2}:\d{2}$/u.test(from) || !/^[+-]\d{2}:\d{2}$/u.test(to))
        throw new BadRequestException("此历史时区偏移不能按分钟准确表示。");
      const fromOffset = ICAL.UtcOffset.fromString(from);
      const toOffset = ICAL.UtcOffset.fromString(to);
      const component = new ICAL.Component(
        toOffset.toSeconds() > fromOffset.toSeconds() ? "daylight" : "standard",
      );
      component.updatePropertyWithValue(
        "dtstart",
        ICAL.Time.fromString(localText(wall), undefined),
      );
      component.updatePropertyWithValue("tzoffsetfrom", fromOffset);
      component.updatePropertyWithValue("tzoffsetto", toOffset);
      zone.addSubcomponent(component);
    };
    observance(first.toPlainDateTime(), first.offset, first.offset);
    let transition = first.getTimeZoneTransition("next");
    while (
      transition &&
      Temporal.ZonedDateTime.compare(transition, last) <= 0
    ) {
      const prior = transition.subtract({ nanoseconds: 1 });
      const localBeforeShift = transition
        .toInstant()
        .add({ nanoseconds: prior.offsetNanoseconds })
        .toZonedDateTimeISO("UTC")
        .toPlainDateTime();
      observance(localBeforeShift, prior.offset, transition.offset);
      transition = transition.getTimeZoneTransition("next");
    }
    root.addSubcomponent(zone);
  }
  const zone = root.getTimeZoneByID(zoneId);
  if (!zone) throw new BadRequestException("无法核实时区定义。");
  return times.map((time) => {
    const local = ICAL.Time.fromString(
      localText(time.toPlainDateTime()),
      undefined,
    );
    local.zone = zone;
    if (local.toUnixTime() !== time.epochMilliseconds / 1000)
      throw new BadRequestException("来源时区定义与当前所选时间不一致。");
    return local;
  });
}

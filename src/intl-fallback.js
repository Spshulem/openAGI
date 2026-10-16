// Stand-in for Intl.DateTimeFormat on a Node built without ICU (today's
// nodejs-mobile prebuilts), where `Intl` is undefined and the daily planner,
// recap and pattern miner throw on first use. Installed only when Intl is
// missing, so desktop Node never sees it.
//
// It renders in the device's own zone using Date's local-time getters, which
// work without ICU and follow the OS zone, DST included. A request for "UTC"
// renders in UTC; any other named zone is treated as the device's zone. That
// is right for a phone (its user lives in its zone) and is replaced by the
// ICU runtime build the phone-only spec calls for.

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n) => String(n).padStart(2, "0");

function deviceZone() {
  return process.env.OPENAGI_TIME_ZONE || process.env.TZ || "UTC";
}

function isUtc(zone) {
  return /^(utc|etc\/utc|gmt|etc\/gmt|z)$/i.test(String(zone ?? ""));
}

function fields(date, utc) {
  return utc
    ? { year: date.getUTCFullYear(), month: date.getUTCMonth(), day: date.getUTCDate(), weekday: date.getUTCDay(), hour: date.getUTCHours(), minute: date.getUTCMinutes(), second: date.getUTCSeconds() }
    : { year: date.getFullYear(), month: date.getMonth(), day: date.getDate(), weekday: date.getDay(), hour: date.getHours(), minute: date.getMinutes(), second: date.getSeconds() };
}

function DateTimeFormat(locale, options = {}) {
  if (!(this instanceof DateTimeFormat)) return new DateTimeFormat(locale, options);
  const zone = options.timeZone ?? deviceZone();
  if (typeof zone !== "string" || !zone.trim()) throw new RangeError(`Invalid time zone specified: ${zone}`);
  this.locale = String(Array.isArray(locale) ? locale[0] ?? "en-US" : locale ?? "en-US");
  this.options = { ...options };
  this.zone = zone;
  const hasDate = ["year", "month", "day", "weekday"].some((key) => options[key]);
  const hasTime = ["hour", "minute", "second"].some((key) => options[key]);
  if (!hasDate && !hasTime) Object.assign(this.options, { year: "numeric", month: "numeric", day: "numeric" });
}

DateTimeFormat.prototype.resolvedOptions = function resolvedOptions() {
  return { locale: this.locale, calendar: "gregory", numberingSystem: "latn", timeZone: this.zone, ...this.options };
};

DateTimeFormat.prototype.formatToParts = function formatToParts(value = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new RangeError("Invalid time value");
  const f = fields(date, isUtc(this.zone));
  const o = this.options;
  const h12 = o.hour12 === true || (o.hour12 !== false && !o.hourCycle && /^en-US$|^en$/i.test(this.locale));
  const parts = [];
  const push = (type, value) => parts.push({ type, value: String(value) });
  const lit = (value) => { if (parts.length) push("literal", value); };
  const num = (style, n) => (style === "2-digit" ? pad(n) : String(n));
  const year = o.year ? (o.year === "2-digit" ? pad(f.year % 100) : String(f.year)) : null;
  const month = o.month ? (o.month === "long" ? MONTHS[f.month] : o.month === "short" ? MONTHS[f.month].slice(0, 3) : num(o.month, f.month + 1)) : null;
  const day = o.day ? num(o.day, f.day) : null;
  const textMonth = o.month === "long" || o.month === "short";

  if (o.weekday) push("weekday", o.weekday === "long" ? WEEKDAYS[f.weekday] : WEEKDAYS[f.weekday].slice(0, 3));
  if (textMonth) {
    if (month) { lit(", "); push("month", month); }
    if (day) { lit(" "); push("day", day); }
    if (year) { lit(", "); push("year", year); }
  } else if (/^en-CA$|^sv/i.test(this.locale)) {
    for (const [type, value] of [["year", year], ["month", month], ["day", day]]) if (value) { lit(parts.length && parts.at(-1).type === "weekday" ? ", " : "-"); push(type, value); }
  } else {
    const order = /^en-GB$|^fr|^de/i.test(this.locale) ? [["day", day], ["month", month], ["year", year]] : [["month", month], ["day", day], ["year", year]];
    for (const [type, value] of order) if (value) { lit(parts.length && parts.at(-1).type === "weekday" ? ", " : "/"); push(type, value); }
  }
  if (o.hour || o.minute || o.second) {
    lit(", ");
    if (o.hour) {
      const hour = h12 ? (f.hour % 12 || 12) : f.hour;
      push("hour", o.hour === "2-digit" || (!h12 && (o.minute || o.hourCycle)) ? pad(hour) : String(hour));
    }
    if (o.minute) { lit(":"); push("minute", pad(f.minute)); }
    if (o.second) { lit(":"); push("second", pad(f.second)); }
    if (o.hour && h12) { push("literal", " "); push("dayPeriod", f.hour < 12 ? "AM" : "PM"); }
  }
  return parts;
};

DateTimeFormat.prototype.format = function format(value) {
  return this.formatToParts(value).map((part) => part.value).join("");
};

DateTimeFormat.supportedLocalesOf = (locales) => [].concat(locales ?? []);

export function installIntlFallback() {
  if (typeof globalThis.Intl !== "undefined") return false;
  globalThis.Intl = { DateTimeFormat };
  return true;
}

export { DateTimeFormat as FallbackDateTimeFormat };

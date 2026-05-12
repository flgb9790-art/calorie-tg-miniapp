const DEFAULT_APP_TIMEZONE = process.env.APP_TIMEZONE || "Europe/Moscow";

/** Проверяет, что строка является поддерживаемой IANA-таймзоной. */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== "string" || !timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timeZone.trim() }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Возвращает первую валидную таймзону, иначе — дефолт приложения. */
export function resolveCalendarTimeZone(...candidates) {
  for (const candidate of candidates) {
    if (isValidTimeZone(candidate)) return candidate.trim();
  }
  return DEFAULT_APP_TIMEZONE;
}

/** Календарная дата YYYY-MM-DD в выбранной таймзоне (для «сегодня» в логе еды). */
export function calendarDateInTimeZone(
  date = new Date(),
  timeZone = DEFAULT_APP_TIMEZONE
) {
  const resolvedTimeZone = resolveCalendarTimeZone(timeZone);
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: resolvedTimeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

/** ISO-дата YYYY-MM-DD минус N календарных дней (по UTC-арифметике компонентов). */
export function subtractCalendarDays(isoDateStr, days) {
  const [y, m, d] = isoDateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - days);
  return dt.toISOString().slice(0, 10);
}

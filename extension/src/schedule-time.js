// Natural-language scheduling restricted to future whole-hour values.

window.MTScheduleTime = (() => {
  "use strict";

  const WEEKDAYS = new Map([
    ["sun", 0], ["sunday", 0],
    ["mon", 1], ["monday", 1],
    ["tue", 2], ["tues", 2], ["tuesday", 2],
    ["wed", 3], ["wednesday", 3],
    ["thu", 4], ["thur", 4], ["thurs", 4], ["thursday", 4],
    ["fri", 5], ["friday", 5],
    ["sat", 6], ["saturday", 6],
  ]);
  const MONTHS = new Map([
    ["jan", 0], ["january", 0], ["feb", 1], ["february", 1],
    ["mar", 2], ["march", 2], ["apr", 3], ["april", 3],
    ["may", 4], ["jun", 5], ["june", 5], ["jul", 6], ["july", 6],
    ["aug", 7], ["august", 7], ["sep", 8], ["sept", 8], ["september", 8],
    ["oct", 9], ["october", 9], ["nov", 10], ["november", 10],
    ["dec", 11], ["december", 11],
  ]);
  const MINIMUM_LEAD_MS = 2 * 60 * 1000;

  function invalid(error) {
    return { valid: false, error };
  }

  function atHour(year, month, day, hour) {
    const date = new Date(year, month, day, hour, 0, 0, 0);
    return date.getFullYear() === year &&
      date.getMonth() === month &&
      date.getDate() === day &&
      date.getHours() === hour
      ? date
      : null;
  }

  function format(date) {
    return new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date);
  }

  function parse(input, now = new Date()) {
    const source = String(input || "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
    if (!source) return invalid("Enter a date and whole-hour time");

    const timeMatch = source.match(/(?:^|\s)(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!timeMatch) return invalid("Include a time such as 11am");
    const minutes = timeMatch[2] == null ? 0 : Number(timeMatch[2]);
    if (minutes !== 0) return invalid("Choose an exact hour with no minutes");

    let hour = Number(timeMatch[1]);
    const meridiem = timeMatch[3]?.toLocaleLowerCase();
    if (meridiem) {
      if (hour < 1 || hour > 12) return invalid("Enter a valid time");
      hour = hour % 12 + (meridiem === "pm" ? 12 : 0);
    } else if (hour < 0 || hour > 23) {
      return invalid("Enter a valid time");
    } else if (hour <= 12) {
      return invalid("Add am or pm");
    }

    const datePhrase = source.slice(0, timeMatch.index).trim().replace(/\s+at$/, "");
    let year = now.getFullYear();
    let month = now.getMonth();
    let day = now.getDate();
    let explicitToday = false;
    let rollForward = false;

    if (!datePhrase) {
      rollForward = true;
    } else if (datePhrase === "today" || datePhrase === "tod") {
      explicitToday = true;
    } else if (datePhrase === "tomorrow" || datePhrase === "tom") {
      const tomorrow = new Date(year, month, day + 1);
      year = tomorrow.getFullYear();
      month = tomorrow.getMonth();
      day = tomorrow.getDate();
    } else if (/^in \d+ days?$/.test(datePhrase)) {
      const days = Number(datePhrase.match(/\d+/)[0]);
      if (days < 1 || days > 366) return invalid("Choose a date within one year");
      const future = new Date(year, month, day + days);
      year = future.getFullYear();
      month = future.getMonth();
      day = future.getDate();
    } else if (WEEKDAYS.has(datePhrase)) {
      const targetDay = WEEKDAYS.get(datePhrase);
      let offset = (targetDay - now.getDay() + 7) % 7;
      const sameDay = atHour(year, month, day, hour);
      if (offset === 0 && (!sameDay || sameDay.getTime() < now.getTime() + MINIMUM_LEAD_MS)) {
        offset = 7;
      }
      const future = new Date(year, month, day + offset);
      year = future.getFullYear();
      month = future.getMonth();
      day = future.getDate();
    } else {
      const iso = datePhrase.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      const named = datePhrase.match(/^([a-z]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
      if (iso) {
        year = Number(iso[1]);
        month = Number(iso[2]) - 1;
        day = Number(iso[3]);
      } else if (named && MONTHS.has(named[1])) {
        month = MONTHS.get(named[1]);
        day = Number(named[2]);
        year = named[3] ? Number(named[3]) : now.getFullYear();
        rollForward = !named[3];
      } else {
        return invalid("Use today, tomorrow, a weekday, or a date");
      }
    }

    let date = atHour(year, month, day, hour);
    if (!date) return invalid("That date or time does not exist");
    if (rollForward && date.getTime() < now.getTime() + MINIMUM_LEAD_MS) {
      if (datePhrase) {
        date = atHour(year + 1, month, day, hour);
      } else {
        const tomorrow = new Date(year, month, day + 1);
        date = atHour(
          tomorrow.getFullYear(),
          tomorrow.getMonth(),
          tomorrow.getDate(),
          hour
        );
      }
    }
    if (!date || date.getTime() < now.getTime() + MINIMUM_LEAD_MS) {
      return invalid(explicitToday ? "That time today has passed" : "Choose a future time");
    }
    if (date.getTime() > now.getTime() + 366 * 24 * 60 * 60 * 1000) {
      return invalid("Choose a date within one year");
    }
    return { valid: true, date, label: format(date) };
  }

  return { parse, format };
})();

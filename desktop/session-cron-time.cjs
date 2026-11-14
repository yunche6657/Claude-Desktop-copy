'use strict';
function parseCron(expression) {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw Error(`Invalid cron expression: expected 5 fields, got ${fields.length}`);
  return { minute: fields[0], hour: fields[1], dayOfMonth: fields[2], month: fields[3], dayOfWeek: fields[4] };
}
function validField(field, min, max) {
  if (field === '*') return true;
  if (field.includes(',')) return field.split(',').every(part => validField(part.trim(), min, max));
  if (field.includes('/')) {
    const [base, step] = field.split('/');
    const value = parseInt(step, 10);
    return isNaN(value) || value < 1 ? false : validField(base, min, max);
  }
  if (field.includes('-')) {
    const [start, end] = field.split('-').map(part => parseInt(part, 10));
    return !isNaN(start) && !isNaN(end) && start >= min && end <= max && start <= end;
  }
  const value = parseInt(field, 10);
  return !isNaN(value) && value >= min && value <= max;
}
function validateCron(expression) {
  try {
    const cron = parseCron(expression);
    return validField(cron.minute, 0, 59) && validField(cron.hour, 0, 23) &&
      validField(cron.dayOfMonth, 1, 31) && validField(cron.month, 1, 12) && validField(cron.dayOfWeek, 0, 7);
  } catch { return false; }
}
function matchField(field, value, min = 0) {
  if (field === '*') return true;
  if (field.includes(',')) return field.split(',').some(part => matchField(part.trim(), value, min));
  if (field.includes('/')) {
    const [base, stepText] = field.split('/');
    const step = parseInt(stepText, 10);
    if (base === '*') return (value - min) % step === 0;
    if (base.includes('-')) {
      const [start, end] = base.split('-').map(part => parseInt(part, 10));
      return value >= start && value <= end && (value - start) % step === 0;
    }
    const start = parseInt(base, 10);
    return value >= start && (value - start) % step === 0;
  }
  if (field.includes('-')) {
    const [start, end] = field.split('-').map(part => parseInt(part, 10));
    return value >= start && value <= end;
  }
  return parseInt(field, 10) === value;
}
function matchesParsed(cron, date) {
  const day = matchField(cron.dayOfMonth, date.getDate(), 1);
  const weekday = date.getDay();
  const week = matchField(cron.dayOfWeek, weekday) || (weekday === 0 && matchField(cron.dayOfWeek, 7));
  const dayMatches = !cron.dayOfMonth.startsWith('*') && !cron.dayOfWeek.startsWith('*') ? day || week : day && week;
  return matchField(cron.minute, date.getMinutes()) && matchField(cron.hour, date.getHours()) &&
    matchField(cron.month, date.getMonth() + 1, 1) && dayMatches;
}
function matchCron(expression, date) {
  return matchesParsed(parseCron(expression), date);
}
function nextCronTime(expression, after = new Date()) {
  const cron = parseCron(expression);
  const now = new Date(after);
  const candidate = new Date(now);
  candidate.setUTCSeconds(0, 0);
  candidate.setTime(candidate.getTime() + 60000);
  for (let i = 0; i < 527040; i++) {
    if (matchesParsed(cron, candidate)) return candidate;
    candidate.setTime(candidate.getTime() + 60000);
  }
  return new Date(now.getTime() + 31536000000);
}
module.exports = { parseCron, validateCron, matchCron, nextCronTime };

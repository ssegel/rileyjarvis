"use strict";

const { addDaysToDate } = require("./priority-lifecycle.cjs");
const { isFutureDeferred, isValidIsoDate } = require("./working-context-lifecycle.cjs");

const EMPTY_STATE = "none.";

const BRIEFING_SECTION_HEADINGS = [
  "Summary",
  "Open priorities",
  "Commitments due now",
  "Other open commitments",
  "Open follow-ups",
  "Open unresolved items",
  "Active projects",
];

const ARCHIVE_FILENAME_RE = /^daily-(\d{4}-\d{2}-\d{2})\.json$/;

function isOpenWorkStatus(status) {
  return status === "open" || status === "blocked";
}

/** Matches memory injection: open | blocked | legacy active. */
function isOpenPriorityStatus(status) {
  return status === "open" || status === "blocked" || status === "active";
}

function isCommitmentDueNow(item, today) {
  const due = String(item?.due || "").trim();
  if (!due) return false;
  return due <= String(today || "");
}

function formatCommitmentLine(item) {
  if (item.sensitivity === "secret") return `- [secret commitment stored] (${item.id})`;
  if (item.sensitivity === "sensitive") return `- [sensitive commitment stored] (${item.id})`;
  return `- ${item.text}${item.due ? ` (due ${item.due})` : ""}`;
}

function formatPriorityLine(item) {
  return `- ${item.text}`;
}

function formatFollowUpLine(item) {
  return `- ${item.text}`;
}

function formatUnresolvedLine(item) {
  return `- ${item.text}`;
}

function formatProjectLine(item) {
  const note = String(item.note || "").trim();
  return note ? `- ${item.name}: ${note}` : `- ${item.name}`;
}

function sectionBodyOrEmpty(lines) {
  return lines.length ? lines.join("\n") : EMPTY_STATE;
}

/**
 * Compose deterministic briefing sections from a loaded daily object.
 * classificationDate = source daily.date (today live or archive snapshot).
 */
function composeDayBriefing(daily) {
  const classificationDate = String(daily?.date || "");
  const summaryRaw = typeof daily?.summary === "string" ? daily.summary.trim() : "";
  const summaryBody = summaryRaw || EMPTY_STATE;

  const openPriorities = (daily.priorities || []).filter((item) => isOpenPriorityStatus(item.status));
  const openCommitments = (daily.commitments || []).filter(
    (item) => isOpenWorkStatus(item.status) && !isFutureDeferred(item, classificationDate),
  );
  const dueNowCommitments = openCommitments.filter((item) => isCommitmentDueNow(item, classificationDate));
  const otherCommitments = openCommitments.filter((item) => !isCommitmentDueNow(item, classificationDate));
  const openFollowUps = (daily.followUps || []).filter(
    (item) => isOpenWorkStatus(item.status) && !isFutureDeferred(item, classificationDate),
  );
  const openUnresolved = (daily.unresolved || []).filter(
    (item) => isOpenWorkStatus(item.status) && !isFutureDeferred(item, classificationDate),
  );
  const activeProjects = daily.activeProjects || [];

  const sections = {
    summary: summaryBody,
    openPriorities: sectionBodyOrEmpty(openPriorities.map(formatPriorityLine)),
    commitmentsDueNow: sectionBodyOrEmpty(dueNowCommitments.map(formatCommitmentLine)),
    otherOpenCommitments: sectionBodyOrEmpty(otherCommitments.map(formatCommitmentLine)),
    openFollowUps: sectionBodyOrEmpty(openFollowUps.map(formatFollowUpLine)),
    openUnresolved: sectionBodyOrEmpty(openUnresolved.map(formatUnresolvedLine)),
    activeProjects: sectionBodyOrEmpty(activeProjects.map(formatProjectLine)),
  };

  const counts = {
    summary: summaryRaw ? 1 : 0,
    openPriorities: openPriorities.length,
    commitmentsDueNow: dueNowCommitments.length,
    otherOpenCommitments: otherCommitments.length,
    openFollowUps: openFollowUps.length,
    openUnresolved: openUnresolved.length,
    activeProjects: activeProjects.length,
  };

  return {
    dailyDate: classificationDate,
    sections,
    counts,
    openPriorities,
    dueNowCommitments,
    otherCommitments,
    openFollowUps,
    openUnresolved,
    activeProjects,
  };
}

function buildBriefingMarkdown(dailyDate, source, composed) {
  const s = composed.sections;
  return [
    `# Day briefing — ${dailyDate}`,
    `Source: ${source}`,
    "",
    `## ${BRIEFING_SECTION_HEADINGS[0]}`,
    s.summary,
    "",
    `## ${BRIEFING_SECTION_HEADINGS[1]}`,
    s.openPriorities,
    "",
    `## ${BRIEFING_SECTION_HEADINGS[2]}`,
    s.commitmentsDueNow,
    "",
    `## ${BRIEFING_SECTION_HEADINGS[3]}`,
    s.otherOpenCommitments,
    "",
    `## ${BRIEFING_SECTION_HEADINGS[4]}`,
    s.openFollowUps,
    "",
    `## ${BRIEFING_SECTION_HEADINGS[5]}`,
    s.openUnresolved,
    "",
    `## ${BRIEFING_SECTION_HEADINGS[6]}`,
    s.activeProjects,
  ].join("\n");
}

function buildBriefingArtifact(dailyDate, source, composed) {
  return {
    title: `Day briefing — ${dailyDate}`,
    kind: "text",
    content: buildBriefingMarkdown(dailyDate, source, composed),
  };
}

/**
 * Resolve brief targetDate against calendarToday.
 * @returns {{ ok: true, resolvedDate: string, source: "today"|"archive" } | { ok: false, code: string, message: string }}
 */
function resolveBriefTarget(targetDate, calendarToday) {
  const today = String(calendarToday || "");
  if (targetDate == null || targetDate === "") {
    return { ok: true, resolvedDate: today, source: "today" };
  }
  if (typeof targetDate !== "string") {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      message: "targetDate must be a string (today, yesterday, or YYYY-MM-DD).",
    };
  }

  const raw = targetDate.trim();
  if (!raw) {
    return { ok: true, resolvedDate: today, source: "today" };
  }

  const lowered = raw.toLowerCase();
  if (lowered === "today") {
    return { ok: true, resolvedDate: today, source: "today" };
  }
  if (lowered === "yesterday") {
    return { ok: true, resolvedDate: addDaysToDate(today, -1), source: "archive" };
  }
  if (lowered === "tomorrow") {
    return {
      ok: false,
      code: "UNSUPPORTED_DATE",
      message: "Tomorrow and future-date briefings are not supported.",
    };
  }

  if (!isValidIsoDate(raw)) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      message: `Invalid targetDate: ${raw}`,
    };
  }

  if (raw === today) {
    return { ok: true, resolvedDate: raw, source: "today" };
  }
  if (raw > today) {
    return {
      ok: false,
      code: "UNSUPPORTED_DATE",
      message: "Tomorrow and future-date briefings are not supported.",
    };
  }
  return { ok: true, resolvedDate: raw, source: "archive" };
}

function parseArchiveFilenameDate(name) {
  const match = ARCHIVE_FILENAME_RE.exec(String(name || ""));
  if (!match) return null;
  const date = match[1];
  if (!isValidIsoDate(date)) return null;
  return date;
}

function sortArchiveDatesDescending(dates) {
  return [...dates].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

function logDayBriefingEvent(details) {
  console.info(
    "[jarvis-memory] day-briefing",
    JSON.stringify({
      operation: details.operation,
      ok: details.ok === true,
      code: details.code || undefined,
      targetDate: details.targetDate || undefined,
      source: details.source || undefined,
      count: details.count != null ? details.count : undefined,
      counts: details.counts || undefined,
      durationMs: details.durationMs != null ? details.durationMs : undefined,
    }),
  );
}

module.exports = {
  EMPTY_STATE,
  BRIEFING_SECTION_HEADINGS,
  isOpenWorkStatus,
  isOpenPriorityStatus,
  isCommitmentDueNow,
  formatCommitmentLine,
  formatPriorityLine,
  formatFollowUpLine,
  formatUnresolvedLine,
  formatProjectLine,
  composeDayBriefing,
  buildBriefingMarkdown,
  buildBriefingArtifact,
  resolveBriefTarget,
  parseArchiveFilenameDate,
  sortArchiveDatesDescending,
  logDayBriefingEvent,
  addDaysToDate,
  isValidIsoDate,
  isFutureDeferred,
};

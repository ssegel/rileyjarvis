import { sanitizeDiagnosticText, type RealtimeErrorCode } from "./realtimeErrors";

export type DiagnosticLevel = "info" | "warn" | "error";

export type DiagnosticResourceCounts = {
  peerConnections?: number;
  remoteAudioElements?: number;
  outputAnalysers?: number;
  microphoneStreams?: number;
  dataChannels?: number;
};

export type DiagnosticEvent = {
  ts: string;
  level: DiagnosticLevel;
  event: string;
  connectionId: string;
  responseId?: string;
  httpStatus?: number;
  errorCode?: RealtimeErrorCode | string;
  message: string;
  resourceCounts?: DiagnosticResourceCounts;
};

export type DiagnosticReportMeta = {
  appVersion?: string;
  branch?: string;
  platform?: string;
  userAgent?: string;
  lastErrorCode?: string;
};

const DEFAULT_CAPACITY = 100;

export class RealtimeDiagnosticsBuffer {
  private events: DiagnosticEvent[] = [];
  private capacity: number;

  constructor(capacity = DEFAULT_CAPACITY) {
    this.capacity = Math.max(1, capacity);
  }

  clear(): void {
    this.events = [];
  }

  size(): number {
    return this.events.length;
  }

  getEvents(): DiagnosticEvent[] {
    return [...this.events];
  }

  record(input: {
    level: DiagnosticLevel;
    event: string;
    connectionId: string;
    responseId?: string;
    httpStatus?: number;
    errorCode?: RealtimeErrorCode | string;
    message: string;
    resourceCounts?: DiagnosticResourceCounts;
  }): DiagnosticEvent {
    const entry: DiagnosticEvent = {
      ts: new Date().toISOString(),
      level: input.level,
      event: sanitizeDiagnosticText(input.event, 80),
      connectionId: sanitizeDiagnosticText(input.connectionId, 64),
      message: sanitizeDiagnosticText(input.message, 240),
    };
    if (input.responseId) entry.responseId = sanitizeDiagnosticText(input.responseId, 80);
    if (typeof input.httpStatus === "number") entry.httpStatus = input.httpStatus;
    if (input.errorCode) entry.errorCode = sanitizeDiagnosticText(String(input.errorCode), 64);
    if (input.resourceCounts) entry.resourceCounts = { ...input.resourceCounts };

    this.events.push(entry);
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity);
    }
    return entry;
  }

  buildCopyableReport(meta: DiagnosticReportMeta = {}, limit = 40): string {
    const slice = this.events.slice(-Math.max(1, limit));
    const lastError = [...this.events].reverse().find((entry) => entry.errorCode || entry.level === "error");
    const header = {
      generatedAt: new Date().toISOString(),
      appVersion: meta.appVersion || "unknown",
      branch: meta.branch || "unknown",
      platform: meta.platform || (typeof navigator !== "undefined" ? navigator.platform : "unknown"),
      userAgent: sanitizeDiagnosticText(meta.userAgent || (typeof navigator !== "undefined" ? navigator.userAgent : ""), 120),
      lastErrorCode: meta.lastErrorCode || lastError?.errorCode || null,
      eventCount: this.events.length,
      includedEvents: slice.length,
    };

    const lines = [
      "Jarvis Realtime Diagnostics",
      JSON.stringify(header, null, 2),
      "",
      "Events:",
      ...slice.map((entry) => JSON.stringify(entry)),
    ];
    return sanitizeReportSecrets(lines.join("\n"));
  }
}

export function sanitizeReportSecrets(report: string): string {
  // Per-event fields are already sanitized; apply secret/HTML redaction without
  // collapsing the entire report via looksLikeHtml on the concatenated text.
  return String(report || "")
    .replace(/(sk-[a-zA-Z0-9_-]{10,})/g, "[redacted-key]")
    .replace(/(ek_[a-zA-Z0-9_-]{10,})/g, "[redacted-token]")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/gi, "$1[redacted-token]")
    .replace(/(password["']?\s*[:=]\s*["']?)[^"'&\s]+/gi, "$1[redacted]")
    .replace(/JARVIS_TOKEN_ERROR:[^\n]+/g, "JARVIS_TOKEN_ERROR:[redacted]")
    .replace(/<!doctype[\s\S]*$/gi, "[html-omitted]")
    .replace(/<html[\s\S]*$/gi, "[html-omitted]");
}

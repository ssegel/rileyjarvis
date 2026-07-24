/**
 * Build sanitized chronological history for independent text turns.
 * Excludes tool/system/status/confirmation/artifact/error/empty lines and
 * dedupes consecutive user messages / current prompt.
 */
export type TextHistoryTranscriptEntry = {
  role: string;
  text: string;
};

export type TextHistoryItem = {
  role: "user" | "assistant";
  text: string;
};

const MAX_HISTORY_ITEMS = 12;

const EXCLUDED_HISTORY_PATTERNS = [
  /^sending/i,
  /^waiting for jarvis/i,
  /^running tools/i,
  /^running [a-z0-9_]+/i,
  /^disconnected$/i,
  /^idle$/i,
  /^connecting$/i,
  /^listening$/i,
  /^thinking$/i,
  /^speaking$/i,
  /^reconnecting$/i,
  /^error$/i,
  /connect voice first/i,
  /jarvis is busy/i,
  /text request/i,
  /something went wrong connecting jarvis/i,
  /the text request failed/i,
  /confirmation required/i,
  /requires confirmation/i,
  /i need confirmation/i,
  /confirm(ed)?\s*=\s*true/i,
  /menu is open in the artifacts? panel/i,
  /rendered in the ui/i,
  /generating image/i,
  /thumbnail board/i,
  /ask jarvis to show/i,
  /mode switched to/i,
  /diagnostics copied/i,
  /could not copy diagnostics/i,
  /^append to memory:/i,
];

export function shouldExcludeTextHistoryText(text: string): boolean {
  const value = String(text || "").trim();
  if (!value) return true;
  return EXCLUDED_HISTORY_PATTERNS.some((pattern) => pattern.test(value));
}

export function buildTextHistoryFromTranscript(
  transcript: TextHistoryTranscriptEntry[],
  currentPrompt: string,
  limit = MAX_HISTORY_ITEMS,
): TextHistoryItem[] {
  const current = String(currentPrompt || "").trim();
  const newestFirst = Array.isArray(transcript) ? transcript : [];
  const chronological = newestFirst
    .filter((entry) => entry.role === "user" || entry.role === "ricky" || entry.role === "assistant")
    .filter((entry) => !shouldExcludeTextHistoryText(entry.text))
    .map((entry) => ({
      role: (entry.role === "ricky" || entry.role === "assistant" ? "assistant" : "user") as
        | "user"
        | "assistant",
      text: String(entry.text || "").trim(),
    }))
    .filter((entry) => entry.text)
    .reverse();

  const deduped: TextHistoryItem[] = [];
  for (const entry of chronological) {
    const prev = deduped[deduped.length - 1];
    if (entry.role === "user" && prev && prev.role === "user" && prev.text === entry.text) continue;
    deduped.push(entry);
  }

  while (
    deduped.length > 0 &&
    deduped[deduped.length - 1].role === "user" &&
    deduped[deduped.length - 1].text === current
  ) {
    deduped.pop();
  }

  return deduped.slice(-limit);
}

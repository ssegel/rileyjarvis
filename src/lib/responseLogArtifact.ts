import type { RickyArtifact } from "../vite-env";

export const RUNNING_RESPONSE_LOG_TITLE = "Running Response Log";

export type ResponseLogEntry = {
  role: string;
  text: string;
  at?: string;
};

/** Build the artifacts-panel view for spoken/typed assistant replies. */
export function buildRunningResponseLogArtifact(entries: ResponseLogEntry[]): RickyArtifact {
  const lines = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry.role === "user" || entry.role === "ricky" || entry.role === "assistant")
    .filter((entry) => String(entry.text || "").trim())
    .slice(0, 40)
    .map((entry) => {
      const label = entry.role === "user" ? "You" : "Jarvis";
      const stamp = entry.at ? ` · ${entry.at}` : "";
      return `${label}${stamp}\n${String(entry.text).trim()}`;
    });

  return {
    title: RUNNING_RESPONSE_LOG_TITLE,
    kind: "text",
    content: lines.join("\n\n"),
  };
}

export function isRunningResponseLogArtifact(artifact: RickyArtifact | null | undefined): boolean {
  return Boolean(artifact && artifact.title === RUNNING_RESPONSE_LOG_TITLE);
}

export function responseLogContainsAssistant(entries: ResponseLogEntry[]): boolean {
  return (Array.isArray(entries) ? entries : []).some(
    (entry) =>
      (entry.role === "ricky" || entry.role === "assistant") && Boolean(String(entry.text || "").trim()),
  );
}

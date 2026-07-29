/// <reference types="vite/client" />

export type RickyArtifact = {
  title: string;
  kind:
    | "text"
    | "markdown"
    | "code"
    | "table"
    | "notes"
    | "mermaid"
    | "image"
    | "imageLoading"
    | "thumbnailBoard"
    | "progress";
  content: string;
  language?: string;
  fullscreen?: boolean;
};

export type RickyToolSpec = {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type RickyToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

export type RickyToolResult = {
  ok: boolean;
  artifact?: RickyArtifact;
  mode?: "display" | "computer";
  message?: string;
  error?: string;
  [key: string]: unknown;
};

export type JarvisTextHistoryItem = {
  role: "user" | "assistant" | "ricky";
  text: string;
};

export type JarvisPendingConfirmationHint = {
  toolName: string;
  operation: string;
  scope?: string | null;
  previewToken: string;
  expiresAt?: number;
  redactedSummary?: string;
  dailyUpdatedAt?: string;
};

export type JarvisPendingConfirmationPublic = {
  toolName: string;
  operation: string;
  scope?: string | null;
  expiresAt: number;
  redactedSummary: string;
  dailyUpdatedAt?: string;
  createdAt: number;
};

export type JarvisBuildInfo = {
  version: string;
  gitSha?: string | null;
  branch?: string | null;
};

export type JarvisContinuitySnapshot = {
  recent: {
    priorityId: string | null;
    activeProjectId: string | null;
    workingContext: {
      commitments: string | null;
      follow_ups: string | null;
      unresolved_items: string | null;
    };
  };
  pendingConfirmation: JarvisPendingConfirmationPublic | null;
  buildInfo: JarvisBuildInfo;
  restartPolicyNote: string;
};

export type JarvisTextTurnRequest = {
  clientTurnId: string;
  text: string;
  history?: JarvisTextHistoryItem[];
  /**
   * When true, main may inject the internal pending confirmation token for this turn.
   * Fresh Send must leave this false/undefined. Preview tokens never come from the renderer.
   */
  resumePendingConfirmation?: boolean;
};

export type JarvisTextToolTraceItem = {
  name: string;
  ok: boolean;
  requiresConfirmation?: boolean;
};

export type JarvisTextUsage = {
  inputTokens: number;
  outputTokens: number;
  model: string;
};

export type JarvisTextTurnError = {
  code: string;
  message: string;
  httpStatus?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  cooldownMs?: number;
  safeForAutoNetworkRetry?: boolean;
  apiErrorType?: string;
  apiErrorCode?: string;
  apiErrorParam?: string;
};

export type JarvisTextTurnResult = {
  ok: boolean;
  clientTurnId: string;
  assistantText: string;
  artifacts: RickyArtifact[];
  toolNames?: string[];
  artifactCount?: number;
  selectedArtifact?: RickyArtifact | null;
  hasSubstantiveArtifact?: boolean;
  toolTrace: JarvisTextToolTraceItem[];
  usage: JarvisTextUsage;
  durationMs: number;
  outcome: "completed" | "cancelled" | "error" | "rejected";
  cancelled: boolean;
  error?: JarvisTextTurnError;
};

export type JarvisTextCancelResult = {
  ok: boolean;
  cancelled?: boolean;
  error?: JarvisTextTurnError;
};

declare global {
  interface Window {
    jarvis: {
      createRealtimeToken: () => Promise<{ value: string; expiresAt: number | null }>;
      executeTool: (toolCall: RickyToolCall) => Promise<RickyToolResult>;
      getToolSpecs: () => Promise<RickyToolSpec[]>;
      copyTextToClipboard: (text: string) => Promise<{ ok: boolean; error?: string }>;
      runTextTurn: (request: JarvisTextTurnRequest) => Promise<JarvisTextTurnResult>;
      cancelTextTurn: (clientTurnId: string) => Promise<JarvisTextCancelResult>;
      getContinuity: () => Promise<JarvisContinuitySnapshot>;
      dismissPendingConfirmation: () => Promise<{ ok: boolean }>;
      getBuildInfo: () => Promise<JarvisBuildInfo>;
    };
  }
}

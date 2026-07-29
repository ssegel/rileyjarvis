/** Pure helpers for pilot baseline UI actions — no first-eligible fallbacks. */

export type PilotBaselineRow = {
  id?: string | null;
  name?: string | null;
  fileName?: string | null;
  registered?: boolean;
  recovered?: boolean;
  invalid?: boolean;
  missing?: boolean;
  conflict?: boolean;
  reason?: string | null;
  size?: number;
  mtimeMs?: number;
  createdAt?: string | null;
};

export type BaselineNameFormMode = "create" | "reregister";

export type BaselineNameFormState = {
  open: boolean;
  mode: BaselineNameFormMode;
  row: PilotBaselineRow | null;
  name: string;
};

export type BaselineNameIpcResult = {
  ok: boolean;
  code?: string;
  message?: string;
};

export function openBaselineNameForm(
  mode: BaselineNameFormMode,
  row: PilotBaselineRow | null = null,
): BaselineNameFormState {
  return {
    open: true,
    mode,
    row,
    name: mode === "reregister" && typeof row?.name === "string" ? row.name : "",
  };
}

export function closeBaselineNameForm(): BaselineNameFormState {
  return { open: false, mode: "create", row: null, name: "" };
}

export function validateBaselineName(name: string):
  | { ok: true; name: string }
  | { ok: false; message: string } {
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    return { ok: false, message: "Baseline name is required." };
  }
  return { ok: true, name: trimmed };
}

/**
 * Shared submission behavior used by the in-app form and behavioral tests.
 * It calls exactly one IPC path and refreshes only after success.
 */
export async function submitBaselineNameAction(options: {
  mode: BaselineNameFormMode;
  row: PilotBaselineRow | null;
  name: string;
  createBaseline: (payload: { name: string }) => Promise<BaselineNameIpcResult>;
  reregisterBaseline: (payload: {
    fileName: string;
    name: string;
  }) => Promise<BaselineNameIpcResult>;
  refresh: () => Promise<void>;
}): Promise<{
  ok: boolean;
  sent: boolean;
  close: boolean;
  message: string;
}> {
  const validated = validateBaselineName(options.name);
  if (!validated.ok) {
    return { ok: false, sent: false, close: false, message: validated.message };
  }

  let result: BaselineNameIpcResult;
  if (options.mode === "create") {
    result = await options.createBaseline({ name: validated.name });
  } else {
    const payload = buildBaselineReregisterPayload(options.row, validated.name);
    if (!payload.ok) {
      return { ok: false, sent: false, close: false, message: payload.message };
    }
    result = await options.reregisterBaseline({
      fileName: payload.fileName,
      name: payload.name,
    });
  }

  const message =
    typeof result?.message === "string" && result.message
      ? result.message
      : result?.ok
        ? "Baseline saved."
        : "Baseline save failed.";
  if (!result?.ok) {
    return { ok: false, sent: true, close: false, message };
  }
  await options.refresh();
  return { ok: true, sent: true, close: true, message };
}

export function formatBaselineStatus(row: PilotBaselineRow): string {
  const flags: string[] = [];
  if (row.conflict) flags.push("conflict");
  if (row.invalid) flags.push("invalid");
  if (row.missing) flags.push("missing");
  if (row.recovered) flags.push("recovered");
  if (row.registered === false) flags.push("unregistered");
  else if (row.registered) flags.push("registered");
  if (row.reason) flags.push(String(row.reason));
  return flags.length ? flags.join(" · ") : "ok";
}

export function buildDeleteConfirmMessage(row: PilotBaselineRow): string {
  const name = String(row.name || "").trim() || "(unnamed)";
  const fileName = String(row.fileName || "").trim() || "(unknown file)";
  return `Delete baseline "${name}" (${fileName})? This cannot be undone by ordinary prune.`;
}

export function buildBaselineDeletePayload(row: PilotBaselineRow | null | undefined): {
  ok: true;
  id?: string;
  fileName: string;
} | { ok: false; code: "NO_SELECTION"; message: string } {
  if (!row || typeof row !== "object") {
    return { ok: false, code: "NO_SELECTION", message: "Select a baseline row before deleting." };
  }
  const fileName = typeof row.fileName === "string" ? row.fileName.trim() : "";
  if (!fileName) {
    return { ok: false, code: "NO_SELECTION", message: "Baseline file name is required to delete." };
  }
  const payload: { ok: true; id?: string; fileName: string } = { ok: true, fileName };
  if (typeof row.id === "string" && row.id.trim()) payload.id = row.id.trim();
  return payload;
}

export function buildBaselineReregisterPayload(
  row: PilotBaselineRow | null | undefined,
  name: string,
): {
  ok: true;
  fileName: string;
  name: string;
} | { ok: false; code: "NO_SELECTION" | "NOT_RECOVERED" | "VALIDATION_FAILED"; message: string } {
  if (!row || typeof row !== "object") {
    return { ok: false, code: "NO_SELECTION", message: "Select a recovered baseline before re-registering." };
  }
  const fileName = typeof row.fileName === "string" ? row.fileName.trim() : "";
  if (!fileName) {
    return { ok: false, code: "NO_SELECTION", message: "Baseline file name is required to re-register." };
  }
  if (row.recovered !== true && row.registered !== false) {
    return {
      ok: false,
      code: "NOT_RECOVERED",
      message: "Only recovered/unregistered baselines can be re-registered.",
    };
  }
  if (row.invalid === true || row.missing === true) {
    return {
      ok: false,
      code: "NOT_RECOVERED",
      message: "Invalid or missing baselines cannot be re-registered.",
    };
  }
  const trimmed = String(name || "").trim();
  if (!trimmed) {
    return { ok: false, code: "VALIDATION_FAILED", message: "Baseline name is required." };
  }
  return { ok: true, fileName, name: trimmed };
}

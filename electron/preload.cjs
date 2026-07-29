const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("jarvis", {
  createRealtimeToken: () => ipcRenderer.invoke("realtime:create-token"),
  executeTool: (toolCall) => ipcRenderer.invoke("tools:execute", toolCall),
  getToolSpecs: () => ipcRenderer.invoke("tools:list"),
  copyTextToClipboard: (text) => ipcRenderer.invoke("clipboard:write-text", text),
  runTextTurn: (request) => ipcRenderer.invoke("text:run", request),
  cancelTextTurn: (clientTurnId) => ipcRenderer.invoke("text:cancel", clientTurnId),
  getContinuity: () => ipcRenderer.invoke("continuity:get"),
  dismissPendingConfirmation: () => ipcRenderer.invoke("continuity:dismiss-pending"),
  confirmPendingConfirmation: () => ipcRenderer.invoke("continuity:confirm-pending", {}),
  getBuildInfo: () => ipcRenderer.invoke("app:get-build-info"),
  listBackups: () => ipcRenderer.invoke("backups:list"),
  createBaseline: (payload) => ipcRenderer.invoke("backups:create-baseline", payload || {}),
  reregisterBaseline: (payload) => ipcRenderer.invoke("backups:reregister-baseline", payload || {}),
  deleteBaseline: (payload) => ipcRenderer.invoke("backups:delete-baseline", payload || {}),
  recordPilotIssue: (payload) => ipcRenderer.invoke("pilot:record-issue", payload || {}),
});

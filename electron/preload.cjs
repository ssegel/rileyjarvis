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
  getBuildInfo: () => ipcRenderer.invoke("app:get-build-info"),
});

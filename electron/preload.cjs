const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("ricky", {
  createRealtimeToken: () => ipcRenderer.invoke("realtime:create-token"),
  executeTool: (toolCall) => ipcRenderer.invoke("tools:execute", toolCall),
  getToolSpecs: () => ipcRenderer.invoke("tools:list"),
});

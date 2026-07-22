const capabilityNames = [
  "openApp",
  "typeText",
  "pressKey",
  "click",
  "scroll",
  "captureScreen",
  "inspectUi",
];

function unsupported(capability) {
  return {
    ok: false,
    platform: "win32",
    phase: 2,
    unsupportedCapability: capability,
    error: `Desktop control capability "${capability}" is not implemented on Windows in Phase 2.`,
  };
}

function createWindowsDesktopControl() {
  return {
    platform: "win32",
    capabilities: () => Object.fromEntries(capabilityNames.map((name) => [name, false])),
    openApp: async () => unsupported("openApp"),
    typeText: async () => unsupported("typeText"),
    pressKey: async () => unsupported("pressKey"),
    click: async () => unsupported("click"),
    scroll: async () => unsupported("scroll"),
    captureScreen: async () => unsupported("captureScreen"),
    inspectUi: async () => unsupported("inspectUi"),
  };
}

module.exports = {
  createWindowsDesktopControl,
};

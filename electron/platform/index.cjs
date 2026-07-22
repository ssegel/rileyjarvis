const { createMacosDesktopControl } = require("./macos.cjs");
const { createWindowsDesktopControl } = require("./windows.cjs");

const capabilityNames = [
  "openApp",
  "typeText",
  "pressKey",
  "click",
  "scroll",
  "captureScreen",
  "inspectUi",
];

function createDesktopControl(options = {}) {
  const platform = options.platform || process.platform;

  if (platform === "darwin") {
    return createMacosDesktopControl(options);
  }
  if (platform === "win32") {
    // Forward Electron APIs such as screen, shell, and desktopCapturer unchanged.
    // Windows UI inspection uses the checked-in PowerShell helper from windows.cjs.
    return createWindowsDesktopControl(options);
  }
  return createUnsupportedDesktopControl(platform);
}

function createUnsupportedDesktopControl(platform) {
  const unsupported = (capability) => ({
    ok: false,
    platform,
    unsupportedCapability: capability,
    error: `Desktop control capability "${capability}" is not supported on platform "${platform}".`,
  });

  return {
    platform,
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
  capabilityNames,
  createDesktopControl,
};

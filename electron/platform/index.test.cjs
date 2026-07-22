const assert = require("node:assert/strict");
const test = require("node:test");
const { capabilityNames, createDesktopControl } = require("./index.cjs");

test("selects the macOS adapter without invoking desktop commands", () => {
  const control = createDesktopControl({ platform: "darwin", dataDir: "unused" });

  assert.equal(control.platform, "darwin");
  assert.deepEqual(control.capabilities(), Object.fromEntries(capabilityNames.map((name) => [name, true])));
});

test("selects the Windows adapter with Phase 2 unsupported capabilities", async () => {
  const control = createDesktopControl({ platform: "win32" });

  assert.equal(control.platform, "win32");
  assert.deepEqual(control.capabilities(), Object.fromEntries(capabilityNames.map((name) => [name, false])));

  for (const capability of capabilityNames) {
    const result = await control[capability]({});
    assert.deepEqual(result, {
      ok: false,
      platform: "win32",
      phase: 2,
      unsupportedCapability: capability,
      error: `Desktop control capability "${capability}" is not implemented on Windows in Phase 2.`,
    });
  }
});

test("returns structured unsupported results on unknown platforms", async () => {
  const control = createDesktopControl({ platform: "linux" });

  assert.equal(control.platform, "linux");
  assert.deepEqual(control.capabilities(), Object.fromEntries(capabilityNames.map((name) => [name, false])));

  for (const capability of capabilityNames) {
    const result = await control[capability]({});
    assert.equal(result.ok, false);
    assert.equal(result.platform, "linux");
    assert.equal(result.unsupportedCapability, capability);
    assert.match(result.error, /not supported on platform "linux"/);
  }
});

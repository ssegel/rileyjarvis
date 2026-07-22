const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");
const {
  applicationAliases,
  createWindowsDesktopControl,
  helperPath,
  keyVirtualKeys,
  runPowerShellInput,
} = require("./windows.cjs");

function createHarness(options = {}) {
  const files = new Map(
    (options.files || [
      "C:\\Windows\\System32\\notepad.exe",
      "C:\\Windows\\System32\\mspaint.exe",
      "C:\\Windows\\explorer.exe",
    ]).map((file) => [file.toLowerCase(), file]),
  );
  const directories = new Set((options.directories || []).map((file) => file.toLowerCase()));
  const openedPaths = [];
  const launchedProcesses = [];
  const inputCalls = [];
  const fsApi = {
    async realpath(candidate) {
      const existing = files.get(candidate.toLowerCase());
      if (!existing && !directories.has(candidate.toLowerCase())) throw new Error("ENOENT");
      return existing || candidate;
    },
    async stat(candidate) {
      if (!files.has(candidate.toLowerCase()) && !directories.has(candidate.toLowerCase())) throw new Error("ENOENT");
      return { isFile: () => !directories.has(candidate.toLowerCase()) };
    },
  };
  const shell = {
    async openPath(candidate) {
      openedPaths.push(candidate);
      return options.openPathError || "";
    },
  };
  const launchProcess = async (executable, args) => {
    launchedProcesses.push({ executable, args });
    if (options.launchError) throw options.launchError;
  };
  const inputRunner = async (operation, payload) => {
    inputCalls.push({ operation, payload });
    if (options.inputError) throw options.inputError;
    return { ok: true, operation };
  };
  const screen = options.screen === null
    ? null
    : options.screen || { dipToScreenPoint: ({ x, y }) => ({ x: x * 2, y: y * 2 }) };
  const control = createWindowsDesktopControl({
    fs: fsApi,
    inputRunner,
    launchProcess,
    screen,
    shell,
    windowsDirectory: "C:\\Windows",
  });
  return { control, inputCalls, launchedProcesses, openedPaths };
}

test("reports only Phase 3 Windows capabilities", async () => {
  const { control } = createHarness();
  assert.deepEqual(control.capabilities(), {
    openApp: true,
    typeText: true,
    pressKey: true,
    click: true,
    scroll: true,
    captureScreen: false,
    inspectUi: false,
  });
  assert.equal((await control.captureScreen()).unsupportedCapability, "captureScreen");
  assert.equal((await control.inspectUi()).unsupportedCapability, "inspectUi");
});

test("opens every exact application alias through mocked launchers", async () => {
  for (const alias of Object.keys(applicationAliases)) {
    const harness = createHarness();
    assert.deepEqual(await harness.control.openApp({ appName: alias }), { ok: true, message: `Opened ${alias}.` });
    const target = applicationAliases[alias];
    if (target.type === "path") {
      assert.equal(harness.openedPaths.length, 1);
      assert.equal(harness.launchedProcesses.length, 0);
    } else {
      assert.equal(harness.openedPaths.length, 0);
      assert.equal(harness.launchedProcesses.length, 1);
      assert.equal(harness.launchedProcesses[0].executable, "C:\\Windows\\explorer.exe");
      assert.deepEqual(
        harness.launchedProcesses[0].args,
        [target.type === "appId" ? `shell:AppsFolder\\${target.value}` : target.value],
      );
    }
  }
});

test("opens a validated absolute executable path containing spaces", async () => {
  const executable = "C:\\Program Files\\Example App\\example.exe";
  const harness = createHarness({ files: [executable] });
  assert.deepEqual(await harness.control.openApp({ appName: executable }), {
    ok: true,
    message: `Opened ${executable}.`,
  });
  assert.deepEqual(harness.openedPaths, [executable]);
});

test("rejects invalid, relative, missing, directory, and non-exe application targets", async () => {
  const directory = "C:\\Program Files\\Example\\folder.exe";
  const harness = createHarness({ files: [], directories: [directory] });
  const cases = [
    [{ appName: "" }, "INVALID_APP_NAME"],
    [{ appName: "unknown app" }, "UNKNOWN_APP"],
    [{ appName: "relative.exe" }, "UNKNOWN_APP"],
    [{ appName: "C:\\Temp\\script.cmd" }, "INVALID_EXECUTABLE"],
    [{ appName: "C:\\Temp\\missing.exe" }, "EXECUTABLE_NOT_FOUND"],
    [{ appName: directory }, "INVALID_EXECUTABLE"],
    [{ appName: "bad\0name" }, "INVALID_APP_NAME"],
  ];
  for (const [args, code] of cases) {
    const result = await harness.control.openApp(args);
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
  }
  assert.deepEqual(harness.openedPaths, []);
  assert.deepEqual(harness.launchedProcesses, []);
});

test("transports text as an uninterpreted structured payload", async () => {
  const harness = createHarness();
  const text = "Quotes ' \" braces {} $env:PATH `n \\ 漢字 😀\r\nnext";
  assert.deepEqual(await harness.control.typeText({ text }), { ok: true, message: "Typed text into the active app." });
  assert.deepEqual(harness.inputCalls, [{ operation: "typeText", payload: { text } }]);
  assert.equal((await harness.control.typeText({ text: `bad\0text` })).code, "INVALID_TEXT");
  assert.equal((await harness.control.typeText({ text: "x".repeat(32_769) })).code, "INVALID_TEXT");
});

test("maps only existing schema keys and clamps repeat to 1 through 20", async () => {
  for (const [key, virtualKey] of Object.entries(keyVirtualKeys)) {
    const harness = createHarness();
    assert.deepEqual(await harness.control.pressKey({ key, repeat: 2 }), { ok: true, message: `Pressed ${key}.` });
    assert.deepEqual(harness.inputCalls, [{ operation: "pressKey", payload: { key, virtualKey, repeat: 2 } }]);
  }

  const harness = createHarness();
  await harness.control.pressKey({ key: "enter", repeat: 0 });
  await harness.control.pressKey({ key: "enter", repeat: 200 });
  await harness.control.pressKey({ key: "enter", repeat: 2.9 });
  assert.deepEqual(harness.inputCalls.map((call) => call.payload.repeat), [1, 20, 2]);
  assert.equal((await harness.control.pressKey({ key: "enter", repeat: Number.NaN })).code, "INVALID_NUMBER");
  assert.match((await harness.control.pressKey({ key: "f1" })).error, /Unsupported key/);
  assert.equal(keyVirtualKeys.delete, 0x08);
});

test("validates DIP coordinates and sends converted negative coordinates", async () => {
  const harness = createHarness();
  assert.deepEqual(await harness.control.click({ x: -120.4, y: 250.6 }), {
    ok: true,
    message: "Clicked -120.4, 250.6.",
  });
  assert.deepEqual(harness.inputCalls, [{ operation: "click", payload: { x: -240, y: 502 } }]);
  assert.equal((await harness.control.click({ x: Infinity, y: 0 })).code, "INVALID_NUMBER");
  assert.equal((await harness.control.click({ x: 1_000_001, y: 0 })).code, "INVALID_NUMBER");
  assert.equal((await createHarness({ screen: null }).control.click({ x: 0, y: 0 })).code, "SCREEN_API_UNAVAILABLE");
});

test("validates scroll directions and bounded wheel deltas", async () => {
  const harness = createHarness();
  for (const [direction, horizontal, delta] of [
    ["up", false, 480],
    ["down", false, -480],
    ["left", true, -480],
    ["right", true, 480],
  ]) {
    assert.equal((await harness.control.scroll({ direction, amount: 4 })).ok, true);
    assert.deepEqual(harness.inputCalls.at(-1), {
      operation: "scroll",
      payload: { direction, amount: 4, horizontal, delta },
    });
  }
  await harness.control.scroll({ direction: "up", amount: 0 });
  await harness.control.scroll({ direction: "up", amount: 200 });
  assert.deepEqual(harness.inputCalls.slice(-2).map((call) => call.payload.amount), [1, 20]);
  assert.equal((await harness.control.scroll({ direction: "diagonal", amount: 1 })).code, "INVALID_DIRECTION");
  assert.equal((await harness.control.scroll({ direction: "up", amount: Infinity })).code, "INVALID_NUMBER");
});

test("propagates mocked helper failures without performing input", async () => {
  const harness = createHarness({ inputError: new Error("mock SendInput failure") });
  await assert.rejects(harness.control.typeText({ text: "not typed" }), /mock SendInput failure/);
});

function createSpawnMock({ stdout = "", stderr = "", code = 0 }) {
  let invocation;
  let stdinValue = "";
  const spawnMock = (executable, args, options) => {
    invocation = { executable, args, options };
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (value) => {
      stdinValue = value;
      queueMicrotask(() => {
        if (stdout) child.stdout.emit("data", stdout);
        if (stderr) child.stderr.emit("data", stderr);
        child.emit("close", code);
      });
    };
    return child;
  };
  return { getInvocation: () => invocation, getStdin: () => stdinValue, spawnMock };
}

test("writes structured JSON to stdin and uses only the checked-in helper", async () => {
  const mock = createSpawnMock({ stdout: '{"ok":true,"operation":"typeText"}' });
  await runPowerShellInput("typeText", { text: "$env:PATH; Remove-Item *" }, {
    spawn: mock.spawnMock,
    systemRoot: "C:\\Windows",
  });
  assert.deepEqual(JSON.parse(mock.getStdin()), {
    operation: "typeText",
    payload: { text: "$env:PATH; Remove-Item *" },
  });
  assert.equal(mock.getInvocation().executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(mock.getInvocation().args, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", helperPath]);
  assert.equal(mock.getInvocation().args.includes("-ExecutionPolicy"), false);
  await assert.rejects(
    runPowerShellInput("probe", {}, { helperPath: path.join(__dirname, "alternate.ps1"), spawn: mock.spawnMock }),
    /Alternate Windows input helper paths/,
  );
});

test("rejects helper diagnostics and malformed stdout", async () => {
  const failed = createSpawnMock({ stderr: "mock diagnostic", code: 1 });
  await assert.rejects(runPowerShellInput("probe", {}, { spawn: failed.spawnMock }), /mock diagnostic/);
  const malformed = createSpawnMock({ stdout: "not json" });
  await assert.rejects(runPowerShellInput("probe", {}, { spawn: malformed.spawnMock }), /Unexpected token|JSON/);
});

test("PowerShell helper probe is non-destructive", { skip: process.platform !== "win32" }, async () => {
  assert.deepEqual(await runPowerShellInput("probe", {}), { ok: true, operation: "probe" });
});

test("PowerShell helper rejects unapproved input before SendInput", { skip: process.platform !== "win32" }, async () => {
  await assert.rejects(
    runPowerShellInput("pressKey", { virtualKey: 0x70, repeat: 1 }),
    /not in the approved key schema/,
  );
  await assert.rejects(
    runPowerShellInput("click", { x: 1_000_001, y: 0 }),
    /outside the allowed bounds/,
  );
});

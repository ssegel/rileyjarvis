const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const path = require("node:path");
const test = require("node:test");
const {
  applicationAliases,
  createWindowsDesktopControl,
  helperPath,
  keyVirtualKeys,
  matchScreenSource,
  physicalPixelSize,
  runPowerShellInput,
} = require("./windows.cjs");

function createThumbnail({ width, height, empty = false, png = Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Buffer.alloc(300, 1)]) }) {
  return {
    isEmpty: () => empty || width < 1 || height < 1,
    getSize: () => ({ width, height }),
    toPNG: () => {
      if (png instanceof Error) throw png;
      return png;
    },
  };
}

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
  const writtenFiles = [];
  const mkdirCalls = [];
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
    async mkdir(candidate, mkdirOptions) {
      mkdirCalls.push({ candidate, mkdirOptions });
      if (options.mkdirError) throw options.mkdirError;
    },
    async writeFile(candidate, contents) {
      writtenFiles.push({ candidate, contents });
      if (options.writeError) throw options.writeError;
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
    dataDir: options.dataDir || "C:\\repo\\data",
    desktopCapturer: options.desktopCapturer,
    fs: fsApi,
    inputRunner,
    launchProcess,
    now: options.now || (() => 1700000000000),
    screen,
    shell,
    windowsDirectory: "C:\\Windows",
  });
  return { control, inputCalls, launchedProcesses, mkdirCalls, openedPaths, writtenFiles };
}

test("reports Phase 4 Windows capabilities with inspectUi still unsupported", async () => {
  const { control } = createHarness();
  assert.deepEqual(control.capabilities(), {
    openApp: true,
    typeText: true,
    pressKey: true,
    click: true,
    scroll: true,
    captureScreen: true,
    inspectUi: false,
  });
  assert.equal((await control.inspectUi()).unsupportedCapability, "inspectUi");
  assert.equal((await control.inspectUi()).phase, 4);
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
  const result = await runPowerShellInput("probe", {});
  assert.equal(result.ok, true);
  assert.equal(result.operation, "probe");
  assert.equal(result.pointerSize, 8);
  assert.equal(result.inputSize, 40);
  assert.equal(result.expectedInputSize, 40);
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

test("marshals multi-character Unicode TypeText without live SendInput", { skip: process.platform !== "win32" }, async () => {
  const fixture = "Keyboard input confirmed";
  const result = await runPowerShellInput("marshalTypeText", { text: fixture });

  assert.equal(result.ok, true);
  assert.equal(result.operation, "marshalTypeText");
  assert.equal(result.pointerSize, 8);
  assert.equal(result.inputSize, 40);
  assert.equal(result.expectedInputSize, 40);
  assert.equal(result.scanOffset, 10);
  assert.equal(result.flagsOffset, 12);
  assert.equal(result.unicodeKeyDown, true);
  assert.equal(result.text, fixture);

  const expectedCodes = [...fixture].map((character) => character.charCodeAt(0));
  assert.deepEqual(result.scanCodes.map(Number), expectedCodes);
  assert.deepEqual(
    result.elementIndexes.map(Number),
    expectedCodes.map((_code, index) => index * 2),
  );
  assert.deepEqual(
    result.downFlags.map(Number),
    expectedCodes.map(() => 0x0004),
  );

  // The pre-fix repeated-character failure came from wrong INPUT stride/size so
  // later wScan values no longer matched the fixture code units. This assertion
  // locks the native 40-byte stride and exact per-character UTF-16 scan codes.
  assert.notEqual(result.inputSize, 28);
  assert.notEqual(result.inputSize, 36);
  assert.equal(new Set(result.scanCodes.map(Number)).size > 1, true);
  assert.equal(result.scanCodes.map(Number).join(","), expectedCodes.join(","));
});

test("physicalPixelSize uses scaleFactor for mixed-DPI displays", () => {
  assert.deepEqual(
    physicalPixelSize({ bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1.25 }),
    { width: 2400, height: 1350, scaleFactor: 1.25 },
  );
  assert.deepEqual(
    physicalPixelSize({ bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 2 }),
    { width: 1600, height: 1200, scaleFactor: 2 },
  );
});

test("matchScreenSource prefers display_id then pixel size then sole source", () => {
  const display = { id: 42, bounds: { x: -100, y: 0, width: 800, height: 600 }, scaleFactor: 1 };
  const pixelSize = { width: 800, height: 600 };
  const byId = { id: "a", display_id: "42", thumbnail: createThumbnail({ width: 10, height: 10 }) };
  const bySize = { id: "b", display_id: "99", thumbnail: createThumbnail({ width: 800, height: 600 }) };
  const other = { id: "c", display_id: "7", thumbnail: createThumbnail({ width: 100, height: 100 }) };
  assert.equal(matchScreenSource([bySize, byId, other], display, pixelSize), byId);
  assert.equal(matchScreenSource([bySize, other], display, pixelSize), bySize);
  assert.equal(matchScreenSource([other], display, pixelSize), other);
  assert.equal(matchScreenSource([bySize, other], { id: 1, bounds: display.bounds }, { width: 1, height: 1 }), null);
});

test("captureScreen writes PNG for the display nearest a negative-origin cursor", async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Buffer.alloc(400, 7)]);
  const leftDisplay = { id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 };
  const rightDisplay = { id: 1, bounds: { x: 0, y: 0, width: 800, height: 600 }, scaleFactor: 2 };
  let requestedThumbnail = null;
  const desktopCapturer = {
    async getSources({ types, thumbnailSize }) {
      requestedThumbnail = { types, thumbnailSize };
      return [
        {
          id: "screen:1",
          display_id: "1",
          thumbnail: createThumbnail({ width: 1600, height: 1200, png: Buffer.alloc(300, 9) }),
        },
        {
          id: "screen:2",
          display_id: "2",
          thumbnail: createThumbnail({ width: 1920, height: 1080, png }),
        },
      ];
    },
  };
  const harness = createHarness({
    desktopCapturer,
    screen: {
      getCursorScreenPoint: () => ({ x: -100, y: 40 }),
      getDisplayNearestPoint: (point) => {
        assert.deepEqual(point, { x: -100, y: 40 });
        return leftDisplay;
      },
      dipToScreenPoint: ({ x, y }) => ({ x, y }),
      getAllDisplays: () => [leftDisplay, rightDisplay],
    },
  });

  const result = await harness.control.captureScreen();
  assert.equal(result.ok, true);
  assert.equal(result.path, "C:\\repo\\data\\screenshot-1700000000000.png");
  assert.equal(result.artifact.title, "Screen Snapshot");
  assert.equal(result.artifact.kind, "image");
  assert.equal(result.artifact.content, `data:image/png;base64,${png.toString("base64")}`);
  assert.deepEqual(result.display, {
    id: 2,
    bounds: { x: -1920, y: 0, width: 1920, height: 1080 },
    scaleFactor: 1,
    pixelSize: { width: 1920, height: 1080 },
  });
  assert.deepEqual(requestedThumbnail, {
    types: ["screen"],
    thumbnailSize: { width: 1920, height: 1080 },
  });
  assert.equal(harness.mkdirCalls.length, 1);
  assert.equal(harness.writtenFiles.length, 1);
  assert.deepEqual(harness.writtenFiles[0].contents, png);
  assert.equal(harness.inputCalls.length, 0);
});

test("captureScreen requests physical pixels for mixed-DPI nearest display", async () => {
  const display = { id: 9, bounds: { x: 100, y: 200, width: 1280, height: 720 }, scaleFactor: 1.5 };
  let requested = null;
  const harness = createHarness({
    desktopCapturer: {
      async getSources({ thumbnailSize }) {
        requested = thumbnailSize;
        return [
          {
            id: "screen:9",
            display_id: "9",
            thumbnail: createThumbnail({ width: 1920, height: 1080 }),
          },
        ];
      },
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 120, y: 220 }),
      getDisplayNearestPoint: () => display,
      dipToScreenPoint: ({ x, y }) => ({ x, y }),
    },
  });
  const result = await harness.control.captureScreen();
  assert.equal(result.ok, true);
  assert.deepEqual(requested, { width: 1920, height: 1080 });
  assert.deepEqual(result.display.pixelSize, { width: 1920, height: 1080 });
  assert.equal(result.display.scaleFactor, 1.5);
});

test("captureScreen reports structured failures for unavailable and empty captures", async () => {
  assert.equal((await createHarness({ screen: null }).control.captureScreen()).code, "CAPTURE_UNAVAILABLE");
  assert.equal(
    (await createHarness({
      screen: {
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => null,
        dipToScreenPoint: ({ x, y }) => ({ x, y }),
      },
      desktopCapturer: { async getSources() { return []; } },
    }).control.captureScreen()).code,
    "CAPTURE_NO_DISPLAYS",
  );
  assert.equal(
    (await createHarness({
      screen: {
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 }),
        dipToScreenPoint: ({ x, y }) => ({ x, y }),
      },
      desktopCapturer: { async getSources() { return []; } },
    }).control.captureScreen()).code,
    "CAPTURE_NO_SOURCES",
  );
  assert.equal(
    (await createHarness({
      screen: {
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 }),
        dipToScreenPoint: ({ x, y }) => ({ x, y }),
      },
      desktopCapturer: {
        async getSources() {
          return [
            { id: "a", display_id: "2", thumbnail: createThumbnail({ width: 10, height: 10 }) },
            { id: "b", display_id: "3", thumbnail: createThumbnail({ width: 11, height: 11 }) },
          ];
        },
      },
    }).control.captureScreen()).code,
    "CAPTURE_NO_MATCHING_SOURCE",
  );
  assert.equal(
    (await createHarness({
      screen: {
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 }),
        dipToScreenPoint: ({ x, y }) => ({ x, y }),
      },
      desktopCapturer: {
        async getSources() {
          return [{ id: "a", display_id: "1", thumbnail: null }];
        },
      },
    }).control.captureScreen()).code,
    "CAPTURE_EMPTY",
  );
  assert.equal(
    (await createHarness({
      screen: {
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 }),
        dipToScreenPoint: ({ x, y }) => ({ x, y }),
      },
      desktopCapturer: {
        async getSources() {
          return [{ id: "a", display_id: "1", thumbnail: createThumbnail({ width: 100, height: 100, empty: true }) }];
        },
      },
    }).control.captureScreen()).code,
    "CAPTURE_PROTECTED_OR_EMPTY",
  );
  assert.equal(
    (await createHarness({
      screen: {
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 }),
        dipToScreenPoint: ({ x, y }) => ({ x, y }),
      },
      desktopCapturer: {
        async getSources() {
          return [{ id: "a", display_id: "1", thumbnail: createThumbnail({ width: 100, height: 100, png: new Error("png boom") }) }];
        },
      },
    }).control.captureScreen()).code,
    "CAPTURE_PNG_FAILED",
  );
  assert.equal(
    (await createHarness({
      mkdirError: new Error("mkdir denied"),
      screen: {
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 }),
        dipToScreenPoint: ({ x, y }) => ({ x, y }),
      },
      desktopCapturer: {
        async getSources() {
          return [{ id: "a", display_id: "1", thumbnail: createThumbnail({ width: 100, height: 100 }) }];
        },
      },
    }).control.captureScreen()).code,
    "CAPTURE_MKDIR_FAILED",
  );
  assert.equal(
    (await createHarness({
      writeError: new Error("disk full"),
      screen: {
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 }),
        dipToScreenPoint: ({ x, y }) => ({ x, y }),
      },
      desktopCapturer: {
        async getSources() {
          return [{ id: "a", display_id: "1", thumbnail: createThumbnail({ width: 100, height: 100 }) }];
        },
      },
    }).control.captureScreen()).code,
    "CAPTURE_WRITE_FAILED",
  );
  assert.equal(
    (await createHarness({
      screen: {
        getCursorScreenPoint: () => ({ x: 0, y: 0 }),
        getDisplayNearestPoint: () => ({ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 }, scaleFactor: 1 }),
        dipToScreenPoint: ({ x, y }) => ({ x, y }),
      },
      desktopCapturer: {
        async getSources() {
          return [{ id: "a", display_id: "1", thumbnail: createThumbnail({ width: 100, height: 100, png: Buffer.from([1, 2, 3]) }) }];
        },
      },
    }).control.captureScreen()).code,
    "CAPTURE_PROTECTED_OR_EMPTY",
  );
});

test("Phase 3 input capabilities remain unchanged and never call macOS binaries", async () => {
  const harness = createHarness({
    desktopCapturer: {
      async getSources() {
        throw new Error("capture should not run during input tests");
      },
    },
  });
  assert.equal((await harness.control.typeText({ text: "ok" })).ok, true);
  assert.equal((await harness.control.pressKey({ key: "enter" })).ok, true);
  assert.equal((await harness.control.scroll({ direction: "down", amount: 1 })).ok, true);
  assert.deepEqual(
    harness.inputCalls.map((call) => call.operation),
    ["typeText", "pressKey", "scroll"],
  );
  assert.equal(JSON.stringify(harness.inputCalls).includes("osascript"), false);
  assert.equal(JSON.stringify(harness.inputCalls).includes("screencapture"), false);
});

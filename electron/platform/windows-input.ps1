$ErrorActionPreference = "Stop"

function Write-Result {
  param([hashtable]$Value)
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 6))
}

function Write-Diagnostic {
  param([string]$Message)
  [Console]::Error.WriteLine($Message)
}

try {
  $rawInput = [Console]::In.ReadToEnd()
  if ([string]::IsNullOrWhiteSpace($rawInput)) {
    throw "Structured JSON input is required."
  }

  $request = $rawInput | ConvertFrom-Json
  $operation = [string]$request.operation
  $payload = $request.payload

  if ($operation -notin @("probe", "marshalTypeText", "typeText", "pressKey", "click", "scroll")) {
    throw "Unsupported Windows input operation."
  }

  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class RickyWindowsInput
{
    private const uint INPUT_MOUSE = 0;
    private const uint INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_UNICODE = 0x0004;
    private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    private const uint MOUSEEVENTF_LEFTUP = 0x0004;
    private const uint MOUSEEVENTF_WHEEL = 0x0800;
    private const uint MOUSEEVENTF_HWHEEL = 0x1000;
    private const ushort VK_RETURN = 0x0D;

    // Native x64 INPUT is 40 bytes: DWORD type + 4-byte pad + 32-byte union.
    // Native x86 INPUT is 28 bytes: DWORD type + 24-byte union.
    [StructLayout(LayoutKind.Explicit, Size = 40)]
    private struct INPUT
    {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public MOUSEINPUT mouse;
        [FieldOffset(8)] public KEYBDINPUT keyboard;
    }

    [StructLayout(LayoutKind.Explicit, Size = 32)]
    private struct MOUSEINPUT
    {
        [FieldOffset(0)] public int dx;
        [FieldOffset(4)] public int dy;
        [FieldOffset(8)] public uint mouseData;
        [FieldOffset(12)] public uint flags;
        [FieldOffset(16)] public uint time;
        [FieldOffset(24)] public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct KEYBDINPUT
    {
        [FieldOffset(0)] public ushort virtualKey;
        [FieldOffset(2)] public ushort scanCode;
        [FieldOffset(4)] public uint flags;
        [FieldOffset(8)] public uint time;
        [FieldOffset(16)] public UIntPtr extraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    public static int InputSize
    {
        get { return Marshal.SizeOf(typeof(INPUT)); }
    }

    public static int ExpectedInputSize
    {
        get { return IntPtr.Size == 8 ? 40 : 28; }
    }

    public static int NativeKeyboardScanOffset
    {
        get { return IntPtr.Size == 8 ? 10 : 6; }
    }

    public static int NativeKeyboardFlagsOffset
    {
        get { return IntPtr.Size == 8 ? 12 : 8; }
    }

    private static INPUT Key(ushort virtualKey, ushort scanCode, uint flags)
    {
        INPUT input = new INPUT();
        input.type = INPUT_KEYBOARD;
        input.keyboard.virtualKey = virtualKey;
        input.keyboard.scanCode = scanCode;
        input.keyboard.flags = flags;
        input.keyboard.time = 0;
        input.keyboard.extraInfo = UIntPtr.Zero;
        return input;
    }

    private static INPUT Mouse(uint flags, int data)
    {
        INPUT input = new INPUT();
        input.type = INPUT_MOUSE;
        input.mouse.dx = 0;
        input.mouse.dy = 0;
        input.mouse.mouseData = unchecked((uint)data);
        input.mouse.flags = flags;
        input.mouse.time = 0;
        input.mouse.extraInfo = UIntPtr.Zero;
        return input;
    }

    private static void Send(INPUT[] inputs)
    {
        int size = InputSize;
        if (size != ExpectedInputSize) {
            throw new InvalidOperationException(
                "INPUT structure size " + size + " does not match native size " + ExpectedInputSize + "."
            );
        }
        uint sent = SendInput((uint)inputs.Length, inputs, size);
        if (sent != inputs.Length) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SendInput did not send every requested event.");
        }
    }

    private static void AddVirtualKey(List<INPUT> inputs, ushort virtualKey)
    {
        inputs.Add(Key(virtualKey, 0, 0));
        inputs.Add(Key(virtualKey, 0, KEYEVENTF_KEYUP));
    }

    private static List<INPUT> BuildTypeTextInputs(string text)
    {
        var inputs = new List<INPUT>();
        for (int index = 0; index < text.Length; index++) {
            char character = text[index];
            if (character == '\r' || character == '\n') {
                if (character == '\r' && index + 1 < text.Length && text[index + 1] == '\n') {
                    index++;
                }
                AddVirtualKey(inputs, VK_RETURN);
            } else {
                inputs.Add(Key(0, character, KEYEVENTF_UNICODE));
                inputs.Add(Key(0, character, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
            }
        }
        return inputs;
    }

    public static int TypeText(string text)
    {
        var inputs = BuildTypeTextInputs(text);
        int sizeCheck = InputSize;
        if (sizeCheck != ExpectedInputSize) {
            throw new InvalidOperationException(
                "INPUT structure size " + sizeCheck + " does not match native size " + ExpectedInputSize + "."
            );
        }
        // Send one UTF-16 code unit at a time to avoid long-array stride fragility.
        for (int index = 0; index + 1 < inputs.Count; index += 2) {
            Send(new[] { inputs[index], inputs[index + 1] });
        }
        return inputs.Count;
    }

    public static string InspectTypeTextMarshal(string text)
    {
        var inputs = BuildTypeTextInputs(text);
        int size = InputSize;
        int scanOffset = NativeKeyboardScanOffset;
        int flagsOffset = NativeKeyboardFlagsOffset;
        var scanCodes = new List<int>();
        var downFlags = new List<uint>();
        var elementIndexes = new List<int>();

        if (size != ExpectedInputSize) {
            return BuildMarshalJson(size, scanCodes, downFlags, elementIndexes, false, "INPUT size mismatch");
        }

        IntPtr buffer = Marshal.AllocHGlobal(checked(size * Math.Max(inputs.Count, 1)));
        try {
            for (int index = 0; index < inputs.Count; index++) {
                IntPtr element = new IntPtr(buffer.ToInt64() + (long)index * size);
                Marshal.StructureToPtr(inputs[index], element, false);
            }

            for (int index = 0; index < inputs.Count; index += 2) {
                IntPtr down = new IntPtr(buffer.ToInt64() + (long)index * size);
                ushort scan = unchecked((ushort)Marshal.ReadInt16(down, scanOffset));
                uint flags = unchecked((uint)Marshal.ReadInt32(down, flagsOffset));
                elementIndexes.Add(index);
                scanCodes.Add(scan);
                downFlags.Add(flags);
            }

            bool unicodeOk = true;
            for (int i = 0; i < downFlags.Count; i++) {
                if ((downFlags[i] & KEYEVENTF_UNICODE) == 0) {
                    unicodeOk = false;
                    break;
                }
            }

            return BuildMarshalJson(size, scanCodes, downFlags, elementIndexes, unicodeOk, null);
        } finally {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string BuildMarshalJson(
        int size,
        List<int> scanCodes,
        List<uint> downFlags,
        List<int> elementIndexes,
        bool unicodeOk,
        string error
    )
    {
        var sb = new StringBuilder();
        sb.Append("{\"pointerSize\":");
        sb.Append(IntPtr.Size);
        sb.Append(",\"inputSize\":");
        sb.Append(size);
        sb.Append(",\"expectedInputSize\":");
        sb.Append(ExpectedInputSize);
        sb.Append(",\"scanOffset\":");
        sb.Append(NativeKeyboardScanOffset);
        sb.Append(",\"flagsOffset\":");
        sb.Append(NativeKeyboardFlagsOffset);
        sb.Append(",\"elementIndexes\":[");
        for (int i = 0; i < elementIndexes.Count; i++) {
            if (i > 0) sb.Append(',');
            sb.Append(elementIndexes[i]);
        }
        sb.Append("],\"scanCodes\":[");
        for (int i = 0; i < scanCodes.Count; i++) {
            if (i > 0) sb.Append(',');
            sb.Append(scanCodes[i]);
        }
        sb.Append("],\"downFlags\":[");
        for (int i = 0; i < downFlags.Count; i++) {
            if (i > 0) sb.Append(',');
            sb.Append(downFlags[i]);
        }
        sb.Append("],\"unicodeKeyDown\":");
        sb.Append(unicodeOk ? "true" : "false");
        if (error != null) {
            sb.Append(",\"error\":\"");
            sb.Append(error.Replace("\\", "\\\\").Replace("\"", "\\\""));
            sb.Append('"');
        }
        sb.Append('}');
        return sb.ToString();
    }

    public static int PressKey(ushort virtualKey, int repeat)
    {
        var inputs = new List<INPUT>();
        for (int index = 0; index < repeat; index++) {
            AddVirtualKey(inputs, virtualKey);
        }
        for (int index = 0; index + 1 < inputs.Count; index += 2) {
            Send(new[] { inputs[index], inputs[index + 1] });
        }
        return inputs.Count;
    }

    public static int Click(int x, int y)
    {
        if (!SetCursorPos(x, y)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SetCursorPos failed.");
        }
        Send(new[] { Mouse(MOUSEEVENTF_LEFTDOWN, 0), Mouse(MOUSEEVENTF_LEFTUP, 0) });
        return 2;
    }

    public static int Scroll(bool horizontal, int delta)
    {
        Send(new[] { Mouse(horizontal ? MOUSEEVENTF_HWHEEL : MOUSEEVENTF_WHEEL, delta) });
        return 1;
    }
}
"@ | Out-Null

  if ($operation -eq "probe") {
    Write-Result @{
      ok = $true
      operation = "probe"
      pointerSize = [IntPtr]::Size
      inputSize = [RickyWindowsInput]::InputSize
      expectedInputSize = [RickyWindowsInput]::ExpectedInputSize
    }
    exit 0
  }

  if ($operation -eq "marshalTypeText") {
    if ($null -eq $payload.text) {
      throw "Text payload is required."
    }
    $text = [string]$payload.text
    if ($text.Length -gt 32768 -or $text.Contains([char]0)) {
      throw "Text payload is outside the allowed bounds."
    }
    $marshalJson = [RickyWindowsInput]::InspectTypeTextMarshal($text)
    $marshal = $marshalJson | ConvertFrom-Json
    Write-Result @{
      ok = $true
      operation = "marshalTypeText"
      pointerSize = [int]$marshal.pointerSize
      inputSize = [int]$marshal.inputSize
      expectedInputSize = [int]$marshal.expectedInputSize
      scanOffset = [int]$marshal.scanOffset
      flagsOffset = [int]$marshal.flagsOffset
      elementIndexes = @($marshal.elementIndexes)
      scanCodes = @($marshal.scanCodes)
      downFlags = @($marshal.downFlags)
      unicodeKeyDown = [bool]$marshal.unicodeKeyDown
      text = $text
    }
    exit 0
  }

  $sent = 0
  switch ($operation) {
    "typeText" {
      if ($null -eq $payload.text) {
        throw "Text payload is required."
      }
      $text = [string]$payload.text
      if ($text.Length -gt 32768 -or $text.Contains([char]0)) {
        throw "Text payload is outside the allowed bounds."
      }
      $sent = [RickyWindowsInput]::TypeText($text)
    }
    "pressKey" {
      $virtualKey = [Convert]::ToUInt16($payload.virtualKey)
      $repeat = [Convert]::ToInt32($payload.repeat)
      if ($virtualKey -notin @(0x0D, 0x09, 0x1B, 0x08, 0x20, 0x26, 0x28, 0x25, 0x27)) {
        throw "Virtual key is not in the approved key schema."
      }
      if ($repeat -lt 1 -or $repeat -gt 20) {
        throw "Key repeat is outside the allowed bounds."
      }
      $sent = [RickyWindowsInput]::PressKey(
        $virtualKey,
        $repeat
      )
    }
    "click" {
      $x = [Convert]::ToInt32($payload.x)
      $y = [Convert]::ToInt32($payload.y)
      if ([Math]::Abs([long]$x) -gt 1000000 -or [Math]::Abs([long]$y) -gt 1000000) {
        throw "Click coordinates are outside the allowed bounds."
      }
      $sent = [RickyWindowsInput]::Click(
        $x,
        $y
      )
    }
    "scroll" {
      $horizontal = [Convert]::ToBoolean($payload.horizontal)
      $delta = [Convert]::ToInt32($payload.delta)
      if ([Math]::Abs([long]$delta) -lt 120 -or [Math]::Abs([long]$delta) -gt 2400 -or $delta % 120 -ne 0) {
        throw "Scroll delta is outside the allowed bounds."
      }
      $sent = [RickyWindowsInput]::Scroll(
        $horizontal,
        $delta
      )
    }
  }

  Write-Result @{ ok = $true; operation = $operation; sent = $sent }
  exit 0
} catch {
  Write-Diagnostic $_.Exception.Message
  exit 1
}

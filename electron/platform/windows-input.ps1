$ErrorActionPreference = "Stop"

function Write-Result {
  param([hashtable]$Value)
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress))
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

  if ($operation -notin @("probe", "typeText", "pressKey", "click", "scroll")) {
    throw "Unsupported Windows input operation."
  }

  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

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

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public INPUTUNION data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct INPUTUNION
    {
        [FieldOffset(0)] public MOUSEINPUT mouse;
        [FieldOffset(0)] public KEYBDINPUT keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort virtualKey;
        public ushort scanCode;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, INPUT[] inputs, int size);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetCursorPos(int x, int y);

    private static INPUT Key(ushort virtualKey, ushort scanCode, uint flags)
    {
        return new INPUT {
            type = INPUT_KEYBOARD,
            data = new INPUTUNION {
                keyboard = new KEYBDINPUT {
                    virtualKey = virtualKey,
                    scanCode = scanCode,
                    flags = flags
                }
            }
        };
    }

    private static INPUT Mouse(uint flags, int data)
    {
        return new INPUT {
            type = INPUT_MOUSE,
            data = new INPUTUNION {
                mouse = new MOUSEINPUT {
                    mouseData = unchecked((uint)data),
                    flags = flags
                }
            }
        };
    }

    private static void Send(INPUT[] inputs)
    {
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
        if (sent != inputs.Length) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SendInput did not send every requested event.");
        }
    }

    private static void AddVirtualKey(List<INPUT> inputs, ushort virtualKey)
    {
        inputs.Add(Key(virtualKey, 0, 0));
        inputs.Add(Key(virtualKey, 0, KEYEVENTF_KEYUP));
    }

    public static int TypeText(string text)
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
        if (inputs.Count > 0) Send(inputs.ToArray());
        return inputs.Count;
    }

    public static int PressKey(ushort virtualKey, int repeat)
    {
        var inputs = new List<INPUT>();
        for (int index = 0; index < repeat; index++) {
            AddVirtualKey(inputs, virtualKey);
        }
        Send(inputs.ToArray());
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
    Write-Result @{ ok = $true; operation = "probe" }
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

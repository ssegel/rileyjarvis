$ErrorActionPreference = "Stop"

function Write-Result {
  param([hashtable]$Value)
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 12))
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

  if ($operation -notin @("probe", "inspectUi")) {
    throw "Unsupported Windows UI inspection operation."
  }

  if ($operation -eq "probe") {
    Write-Result @{
      ok = $true
      operation = "probe"
      helper = "windows-ui"
      maxDepth = 4
      maxNodes = 120
    }
    exit 0
  }

  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes

  Add-Type -ReferencedAssemblies @(
    "UIAutomationClient",
    "UIAutomationTypes",
    "WindowsBase",
    "System.Xml"
  ) -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows;
using System.Windows.Automation;

public static class RickyWindowsUiInspect
{
    public const int MaxDepth = 4;
    public const int MaxNodes = 120;
    public const int MaxValueLength = 80;

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern IntPtr GetThreadDesktop(uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetUserObjectInformation(
        IntPtr hObj,
        int nIndex,
        StringBuilder pvInfo,
        int nLength,
        out int lpnLengthNeeded);

    private const int UOI_NAME = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    public sealed class BoundsInfo
    {
        public int x;
        public int y;
        public int width;
        public int height;
    }

    public sealed class AppInfo
    {
        public string name;
        public string processName;
        public int pid;
        public string path;
    }

    public sealed class WindowInfo
    {
        public string title;
        public string className;
        public string handle;
        public string controlType;
        public BoundsInfo bounds;
    }

    public sealed class NodeInfo
    {
        public string name;
        public string controlType;
        public string role;
        public string automationId;
        public BoundsInfo bounds;
        public bool enabled;
        public bool focused;
        public bool offscreen;
        public string value;
        public bool redacted;
        public int depth;
        public int childCount;
    }

    public sealed class MetaInfo
    {
        public int depthLimit;
        public int nodeLimit;
        public int visited;
        public int returned;
        public int skipped;
        public bool truncated;
        public bool limited;
        public int redactedCount;
    }

    public sealed class InspectResult
    {
        public bool ok;
        public string code;
        public string error;
        public AppInfo app;
        public WindowInfo window;
        public NodeInfo focused;
        public List<NodeInfo> tree;
        public MetaInfo meta;
    }

    public static InspectResult InspectForeground()
    {
        var result = new InspectResult
        {
            ok = false,
            tree = new List<NodeInfo>(),
            meta = new MetaInfo
            {
                depthLimit = MaxDepth,
                nodeLimit = MaxNodes,
                visited = 0,
                returned = 0,
                skipped = 0,
                truncated = false,
                limited = false,
                redactedCount = 0
            }
        };

        IntPtr hwnd = GetForegroundWindow();
        if (hwnd == IntPtr.Zero)
        {
            result.code = "INSPECT_NO_FOREGROUND";
            result.error = "No foreground window is available for UI inspection.";
            return result;
        }

        uint processId;
        uint threadId = GetWindowThreadProcessId(hwnd, out processId);
        if (IsSecureDesktop(threadId, processId))
        {
            result.code = "INSPECT_SECURE_DESKTOP";
            result.error = "Foreground UI is on a secure desktop and cannot be inspected.";
            return result;
        }

        string title = GetWindowTextValue(hwnd);
        string className = GetClassNameValue(hwnd);
        BoundsInfo windowBounds = GetWindowBounds(hwnd);

        AppInfo app;
        try
        {
            app = GetAppInfo((int)processId);
        }
        catch (Exception ex)
        {
            result.code = "INSPECT_ACCESS_DENIED";
            result.error = "Unable to identify the foreground process: " + ex.Message;
            return result;
        }

        if (IsProtectedProcessName(app.processName))
        {
            result.code = "INSPECT_SECURE_DESKTOP";
            result.error = "Foreground UI belongs to a secure or logon process and cannot be inspected.";
            return result;
        }

        AutomationElement root;
        try
        {
            root = AutomationElement.FromHandle(hwnd);
        }
        catch (UnauthorizedAccessException ex)
        {
            result.code = "INSPECT_ACCESS_DENIED";
            result.error = "Access to the foreground UI Automation tree was denied: " + ex.Message;
            return result;
        }
        catch (ElementNotAvailableException ex)
        {
            result.code = "INSPECT_ROOT_FAILED";
            result.error = "Foreground UI Automation element is unavailable: " + ex.Message;
            return result;
        }
        catch (Exception ex)
        {
            if (LooksLikeAccessDenied(ex))
            {
                result.code = "INSPECT_ACCESS_DENIED";
                result.error = "Access to the foreground UI Automation tree was denied: " + ex.Message;
                return result;
            }
            result.code = "INSPECT_ROOT_FAILED";
            result.error = "Failed to resolve the UI Automation root: " + ex.Message;
            return result;
        }

        if (root == null)
        {
            result.code = "INSPECT_ROOT_FAILED";
            result.error = "UI Automation returned no root element for the foreground window.";
            return result;
        }

        try
        {
            string rootControlType = GetControlTypeName(root);
            result.app = app;
            result.window = new WindowInfo
            {
                title = string.IsNullOrWhiteSpace(title) ? SafeName(root) : title,
                className = className,
                handle = hwnd.ToString(),
                controlType = rootControlType,
                bounds = windowBounds ?? GetBounds(root)
            };

            NodeInfo focusedNode = null;
            try
            {
                AutomationElement focused = AutomationElement.FocusedElement;
                if (focused != null)
                {
                    focusedNode = BuildNode(focused, EstimateDepth(root, focused), result.meta, includeEvenIfOffscreen: true);
                }
            }
            catch
            {
                // Focused element is best-effort.
            }
            result.focused = focusedNode;

            Walk(root, 0, result.tree, result.meta);

            result.ok = true;
            result.meta.returned = result.tree.Count;
            result.meta.limited = result.meta.skipped > 0 || result.meta.truncated || result.meta.redactedCount > 0;
            return result;
        }
        catch (UnauthorizedAccessException ex)
        {
            result.code = "INSPECT_ACCESS_DENIED";
            result.error = "Access denied while reading the UI Automation tree: " + ex.Message;
            return result;
        }
        catch (Exception ex)
        {
            if (LooksLikeAccessDenied(ex))
            {
                result.code = "INSPECT_ACCESS_DENIED";
                result.error = "Access denied while reading the UI Automation tree: " + ex.Message;
                return result;
            }
            result.code = "INSPECT_ROOT_FAILED";
            result.error = "UI Automation inspection failed: " + ex.Message;
            return result;
        }
    }

    private static void Walk(AutomationElement element, int depth, List<NodeInfo> tree, MetaInfo meta)
    {
        if (element == null) return;
        meta.visited++;

        bool offscreen = false;
        try { offscreen = element.Current.IsOffscreen; }
        catch { meta.skipped++; return; }

        if (offscreen && depth > 0)
        {
            meta.skipped++;
            return;
        }

        if (tree.Count >= MaxNodes)
        {
            meta.truncated = true;
            meta.skipped++;
            return;
        }

        if (depth > MaxDepth)
        {
            meta.truncated = true;
            meta.skipped++;
            return;
        }

        NodeInfo node;
        try
        {
            node = BuildNode(element, depth, meta, includeEvenIfOffscreen: depth == 0);
        }
        catch
        {
            meta.skipped++;
            return;
        }

        if (node == null)
        {
            meta.skipped++;
            return;
        }

        tree.Add(node);

        if (depth >= MaxDepth)
        {
            if (node.childCount > 0) meta.truncated = true;
            return;
        }

        AutomationElement child = null;
        try
        {
            child = TreeWalker.ControlViewWalker.GetFirstChild(element);
        }
        catch
        {
            meta.skipped++;
            return;
        }

        while (child != null)
        {
            if (tree.Count >= MaxNodes)
            {
                meta.truncated = true;
                meta.skipped++;
                break;
            }

            try
            {
                Walk(child, depth + 1, tree, meta);
            }
            catch
            {
                meta.skipped++;
            }

            try
            {
                child = TreeWalker.ControlViewWalker.GetNextSibling(child);
            }
            catch
            {
                meta.skipped++;
                break;
            }
        }
    }

    private static NodeInfo BuildNode(AutomationElement element, int depth, MetaInfo meta, bool includeEvenIfOffscreen)
    {
        AutomationElement.AutomationElementInformation current = element.Current;
        bool offscreen = current.IsOffscreen;
        if (offscreen && !includeEvenIfOffscreen) return null;

        int childCount = 0;
        try
        {
            AutomationElement probe = TreeWalker.ControlViewWalker.GetFirstChild(element);
            while (probe != null)
            {
                childCount++;
                probe = TreeWalker.ControlViewWalker.GetNextSibling(probe);
                if (childCount > 500) break;
            }
        }
        catch
        {
            childCount = 0;
        }

        string controlType = GetControlTypeName(element);
        string name = SafeName(element);
        string automationId = null;
        try
        {
            automationId = current.AutomationId;
            if (string.IsNullOrWhiteSpace(automationId)) automationId = null;
        }
        catch { automationId = null; }

        bool enabled = true;
        try { enabled = current.IsEnabled; } catch { enabled = false; }

        bool focused = false;
        try { focused = current.HasKeyboardFocus; } catch { focused = false; }

        bool isPassword = false;
        try { isPassword = current.IsPassword; } catch { isPassword = false; }
        if (!isPassword) isPassword = IsObviousPasswordControl(controlType, name, automationId);

        string value = null;
        bool redacted = false;
        if (isPassword)
        {
            redacted = true;
            meta.redactedCount++;
        }
        else
        {
            value = TryGetSafeValue(element, controlType);
        }

        return new NodeInfo
        {
            name = name,
            controlType = controlType,
            role = controlType,
            automationId = automationId,
            bounds = GetBounds(element),
            enabled = enabled,
            focused = focused,
            offscreen = offscreen,
            value = value,
            redacted = redacted,
            depth = depth,
            childCount = childCount
        };
    }

    private static string TryGetSafeValue(AutomationElement element, string controlType)
    {
        if (!IsSafeValueControlType(controlType)) return null;

        string raw = null;
        try
        {
            object patternObj;
            if (element.TryGetCurrentPattern(ValuePattern.Pattern, out patternObj))
            {
                ValuePattern valuePattern = patternObj as ValuePattern;
                if (valuePattern != null) raw = valuePattern.Current.Value;
            }
        }
        catch
        {
            return null;
        }

        if (string.IsNullOrEmpty(raw)) return null;
        if (raw.IndexOf('\n') >= 0 || raw.IndexOf('\r') >= 0) return null;
        if (raw.Length > MaxValueLength) return raw.Substring(0, MaxValueLength);
        return raw;
    }

    private static bool IsSafeValueControlType(string controlType)
    {
        if (string.IsNullOrEmpty(controlType)) return false;
        switch (controlType)
        {
            case "Text":
            case "Edit":
            case "ComboBox":
            case "Spinner":
            case "Slider":
                return true;
            default:
                return false;
        }
    }

    private static bool IsObviousPasswordControl(string controlType, string name, string automationId)
    {
        if (string.Equals(controlType, "Password", StringComparison.OrdinalIgnoreCase)) return true;
        string haystack = ((name ?? "") + " " + (automationId ?? "")).ToLowerInvariant();
        if (haystack.IndexOf("password", StringComparison.Ordinal) >= 0) return true;
        if (haystack.IndexOf("passwd", StringComparison.Ordinal) >= 0) return true;
        if (haystack.IndexOf("pinbox", StringComparison.Ordinal) >= 0) return true;
        return false;
    }

    private static string GetControlTypeName(AutomationElement element)
    {
        try
        {
            ControlType type = element.Current.ControlType;
            if (type == null) return "Unknown";
            string program = type.ProgrammaticName;
            if (!string.IsNullOrEmpty(program) && program.StartsWith("ControlType."))
            {
                return program.Substring("ControlType.".Length);
            }
            return type.LocalizedControlType ?? "Unknown";
        }
        catch
        {
            return "Unknown";
        }
    }

    private static string SafeName(AutomationElement element)
    {
        try
        {
            string name = element.Current.Name;
            if (string.IsNullOrWhiteSpace(name)) return "";
            if (name.Length > 200) return name.Substring(0, 200);
            return name;
        }
        catch
        {
            return "";
        }
    }

    private static BoundsInfo GetBounds(AutomationElement element)
    {
        try
        {
            Rect rect = element.Current.BoundingRectangle;
            if (double.IsNaN(rect.X) || double.IsNaN(rect.Y) || double.IsNaN(rect.Width) || double.IsNaN(rect.Height))
            {
                return null;
            }
            return new BoundsInfo
            {
                x = (int)Math.Round(rect.X),
                y = (int)Math.Round(rect.Y),
                width = (int)Math.Round(rect.Width),
                height = (int)Math.Round(rect.Height)
            };
        }
        catch
        {
            return null;
        }
    }

    private static BoundsInfo GetWindowBounds(IntPtr hwnd)
    {
        RECT rect;
        if (!GetWindowRect(hwnd, out rect)) return null;
        return new BoundsInfo
        {
            x = rect.Left,
            y = rect.Top,
            width = Math.Max(0, rect.Right - rect.Left),
            height = Math.Max(0, rect.Bottom - rect.Top)
        };
    }

    private static string GetWindowTextValue(IntPtr hwnd)
    {
        var buffer = new StringBuilder(1024);
        GetWindowText(hwnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    private static string GetClassNameValue(IntPtr hwnd)
    {
        var buffer = new StringBuilder(256);
        GetClassName(hwnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    private static AppInfo GetAppInfo(int processId)
    {
        Process process = Process.GetProcessById(processId);
        string processName = process.ProcessName ?? "";
        string path = null;
        try { path = process.MainModule != null ? process.MainModule.FileName : null; }
        catch { path = null; }

        string friendly = process.MainWindowTitle;
        if (string.IsNullOrWhiteSpace(friendly)) friendly = processName;

        return new AppInfo
        {
            name = string.IsNullOrWhiteSpace(processName) ? friendly : processName,
            processName = processName,
            pid = processId,
            path = path
        };
    }

    private static bool IsSecureDesktop(uint threadId, uint processId)
    {
        try
        {
            IntPtr desktop = GetThreadDesktop(threadId);
            if (desktop != IntPtr.Zero)
            {
                var name = new StringBuilder(256);
                int needed;
                if (GetUserObjectInformation(desktop, UOI_NAME, name, name.Capacity * 2, out needed))
                {
                    string desktopName = name.ToString();
                    if (string.Equals(desktopName, "Winlogon", StringComparison.OrdinalIgnoreCase)) return true;
                }
            }
        }
        catch { }

        try
        {
            Process process = Process.GetProcessById((int)processId);
            return IsProtectedProcessName(process.ProcessName);
        }
        catch
        {
            return false;
        }
    }

    private static bool IsProtectedProcessName(string processName)
    {
        if (string.IsNullOrWhiteSpace(processName)) return false;
        string name = processName.ToLowerInvariant();
        return name == "logonui" || name == "winlogon" || name == "consent";
    }

    private static bool LooksLikeAccessDenied(Exception ex)
    {
        string message = (ex.Message ?? "").ToLowerInvariant();
        return message.Contains("access is denied")
            || message.Contains("access denied")
            || message.Contains("unauthorized")
            || message.Contains("0x80070005");
    }

    private static int EstimateDepth(AutomationElement root, AutomationElement target)
    {
        if (root == null || target == null) return 0;
        try
        {
            if (Automation.Compare(root, target)) return 0;
        }
        catch { }

        // Best-effort depth estimate for focused metadata only.
        return 1;
    }
}
"@

  $inspect = [RickyWindowsUiInspect]::InspectForeground()

  if (-not $inspect.ok) {
    Write-Result @{
      ok = $false
      code = $inspect.code
      error = $inspect.error
    }
    exit 0
  }

  function Convert-Bounds {
    param($Bounds)
    if ($null -eq $Bounds) { return $null }
    return @{
      x = [int]$Bounds.x
      y = [int]$Bounds.y
      width = [int]$Bounds.width
      height = [int]$Bounds.height
    }
  }

  function Convert-Node {
    param($Node)
    if ($null -eq $Node) { return $null }
    $item = @{
      name = [string]$Node.name
      controlType = [string]$Node.controlType
      role = [string]$Node.role
      enabled = [bool]$Node.enabled
      focused = [bool]$Node.focused
      offscreen = [bool]$Node.offscreen
      redacted = [bool]$Node.redacted
      depth = [int]$Node.depth
      childCount = [int]$Node.childCount
    }
    if ($Node.automationId) { $item.automationId = [string]$Node.automationId }
    $bounds = Convert-Bounds $Node.bounds
    if ($null -ne $bounds) { $item.bounds = $bounds }
    if ($Node.redacted) {
      $item.redacted = $true
    } elseif ($null -ne $Node.value -and $Node.value -ne "") {
      $item.value = [string]$Node.value
    }
    return $item
  }

  $tree = @()
  foreach ($node in $inspect.tree) {
    $tree += ,(Convert-Node $node)
  }

  Write-Result @{
    ok = $true
    operation = "inspectUi"
    app = @{
      name = [string]$inspect.app.name
      processName = [string]$inspect.app.processName
      pid = [int]$inspect.app.pid
      path = $(if ($inspect.app.path) { [string]$inspect.app.path } else { $null })
    }
    window = @{
      title = [string]$inspect.window.title
      className = [string]$inspect.window.className
      handle = [string]$inspect.window.handle
      controlType = [string]$inspect.window.controlType
      bounds = (Convert-Bounds $inspect.window.bounds)
    }
    focused = (Convert-Node $inspect.focused)
    tree = $tree
    meta = @{
      depthLimit = [int]$inspect.meta.depthLimit
      nodeLimit = [int]$inspect.meta.nodeLimit
      visited = [int]$inspect.meta.visited
      returned = [int]$inspect.meta.returned
      skipped = [int]$inspect.meta.skipped
      truncated = [bool]$inspect.meta.truncated
      limited = [bool]$inspect.meta.limited
      redactedCount = [int]$inspect.meta.redactedCount
    }
  }
  exit 0
} catch {
  Write-Diagnostic $_.Exception.Message
  exit 1
}

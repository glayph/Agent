import { execFile, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { getErrorMessage } from "../errors.js";

interface ExecFileResult {
  stdout: string;
  stderr: string;
}

interface ComputerPowerShellResult<T = unknown> {
  ok?: boolean;
  action?: string;
  data?: T;
  message?: string;
  error?: string;
}

interface ComputerElementLocator {
  id?: string;
  name?: string;
  automationId?: string;
  controlType?: string;
  className?: string;
  runtimeId?: string;
  path?: string;
  windowHandle?: number;
  windowTitle?: string;
  processName?: string;
}

interface ComputerWindowTarget {
  windowHandle?: number;
  windowTitle?: string;
  processName?: string;
}

interface ComputerObserveOptions extends ComputerWindowTarget {
  activeOnly?: boolean;
  maxElements?: number;
  query?: string;
}

interface ComputerObserveData {
  activeWindow?: Record<string, unknown>;
  targetWindow?: Record<string, unknown>;
  topWindows?: Record<string, unknown>[];
  elements?: Array<Record<string, unknown>>;
  elementCount?: number;
}

const COMPUTER_POWERSHELL_SCRIPT = String.raw`
param([string]$PayloadBase64)

function New-HiroResult {
  param(
    [bool]$Ok,
    [string]$Action,
    [object]$Data,
    [string]$Message,
    [string]$ErrorMessage
  )

  $result = [ordered]@{
    ok = $Ok
    action = $Action
  }
  if ($null -ne $Data) { $result.data = $Data }
  if ($Message) { $result.message = $Message }
  if ($ErrorMessage) { $result.error = $ErrorMessage }
  return $result
}

function Initialize-HiroComputer {
  Add-Type -AssemblyName UIAutomationClient | Out-Null
  Add-Type -AssemblyName UIAutomationTypes | Out-Null

  if (-not ([System.Management.Automation.PSTypeName]'HiroNativeWin32').Type) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class HiroNativeWin32 {
  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
}
"@ | Out-Null
  }
}

function Get-HiroProperty {
  param([object]$Object, [string]$Name)
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $null }
  return $property.Value
}

function Get-HiroControlTypeName {
  param([object]$Element)
  try {
    return $Element.Current.ControlType.ProgrammaticName.Replace("ControlType.", "")
  } catch {
    return ""
  }
}

function Get-HiroRuntimeId {
  param([object]$Element)
  try {
    return (($Element.GetRuntimeId() | ForEach-Object { $_.ToString() }) -join ".")
  } catch {
    return ""
  }
}

function Get-HiroProcessName {
  param([int]$ProcessId)
  try {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $process) { return "" }
    return $process.ProcessName
  } catch {
    return ""
  }
}

function Get-HiroProcessIdFromHandle {
  param([int64]$Handle)
  try {
    [uint32]$processId = 0
    [HiroNativeWin32]::GetWindowThreadProcessId([IntPtr]::new($Handle), [ref]$processId) | Out-Null
    return [int]$processId
  } catch {
    return 0
  }
}

function Get-HiroElementValue {
  param([object]$Element)
  try {
    $pattern = $null
    if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
      return $pattern.Current.Value
    }
  } catch {
  }
  return ""
}

function Get-HiroElementInfo {
  param(
    [object]$Element,
    [int]$Depth,
    [string]$Path,
    [int64]$WindowHandle,
    [string]$WindowTitle
  )

  $current = $Element.Current
  $rect = $current.BoundingRectangle
  $nativeHandle = [int64]$current.NativeWindowHandle
  $processId = [int]$current.ProcessId
  if ($WindowHandle -le 0 -and $nativeHandle -gt 0) {
    $WindowHandle = $nativeHandle
  }
  if (-not $WindowTitle) {
    $WindowTitle = $current.Name
  }

  return [ordered]@{
    name = [string]$current.Name
    automationId = [string]$current.AutomationId
    controlType = Get-HiroControlTypeName $Element
    className = [string]$current.ClassName
    runtimeId = Get-HiroRuntimeId $Element
    path = $Path
    processId = $processId
    processName = Get-HiroProcessName $processId
    windowHandle = $WindowHandle
    windowTitle = [string]$WindowTitle
    enabled = [bool]$current.IsEnabled
    offscreen = [bool]$current.IsOffscreen
    focusable = [bool]$current.IsKeyboardFocusable
    value = Get-HiroElementValue $Element
    rect = [ordered]@{
      x = [double]$rect.X
      y = [double]$rect.Y
      width = [double]$rect.Width
      height = [double]$rect.Height
    }
    depth = $Depth
  }
}

function Test-HiroElementMatches {
  param([object]$Info, [string]$Query)
  if (-not $Query) { return $true }
  $needle = $Query.ToLowerInvariant()
  $haystack = @(
    $Info.name,
    $Info.automationId,
    $Info.controlType,
    $Info.className,
    $Info.value,
    $Info.windowTitle,
    $Info.processName
  ) -join " "
  return $haystack.ToLowerInvariant().Contains($needle)
}

function Get-HiroTopWindows {
  param([int]$MaxWindows)
  $items = New-Object 'System.Collections.Generic.List[object]'
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Window
  )
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    $condition
  )

  for ($i = 0; $i -lt $windows.Count -and $items.Count -lt $MaxWindows; $i++) {
    $window = $windows.Item($i)
    try {
      $handle = [int64]$window.Current.NativeWindowHandle
      if ($handle -le 0) { continue }
      if (-not [HiroNativeWin32]::IsWindowVisible([IntPtr]::new($handle))) { continue }
      $info = Get-HiroElementInfo $window 0 "window.$i" $handle $window.Current.Name
      if ($info.name -or $info.processName) {
        $items.Add($info) | Out-Null
      }
    } catch {
    }
  }
  return $items
}

function Get-HiroActiveWindow {
  $handle = [int64][HiroNativeWin32]::GetForegroundWindow()
  if ($handle -le 0) { return $null }
  try {
    $element = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($handle))
    return Get-HiroElementInfo $element 0 "active" $handle $element.Current.Name
  } catch {
    return [ordered]@{
      windowHandle = $handle
      processId = Get-HiroProcessIdFromHandle $handle
      processName = Get-HiroProcessName (Get-HiroProcessIdFromHandle $handle)
    }
  }
}

function Find-HiroWindow {
  param([object]$Payload)
  $windowHandle = Get-HiroProperty $Payload "windowHandle"
  if ($windowHandle) {
    return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([int64]$windowHandle))
  }

  $windowTitle = [string](Get-HiroProperty $Payload "windowTitle")
  $processName = [string](Get-HiroProperty $Payload "processName")
  if ($windowTitle -or $processName) {
    $windows = Get-HiroTopWindows 100
    foreach ($info in $windows) {
      $titleMatches = (-not $windowTitle) -or ([string]$info.name).ToLowerInvariant().Contains($windowTitle.ToLowerInvariant())
      $processMatches = (-not $processName) -or ([string]$info.processName).ToLowerInvariant().Contains($processName.ToLowerInvariant())
      if ($titleMatches -and $processMatches -and $info.windowHandle) {
        return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new([int64]$info.windowHandle))
      }
    }
  }

  $activeHandle = [int64][HiroNativeWin32]::GetForegroundWindow()
  if ($activeHandle -gt 0) {
    return [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]::new($activeHandle))
  }
  return [System.Windows.Automation.AutomationElement]::RootElement
}

function Get-HiroElementTree {
  param(
    [object]$Root,
    [int]$MaxElements,
    [string]$Query,
    [int]$MaxDepth
  )

  $items = New-Object 'System.Collections.Generic.List[object]'
  $queue = New-Object 'System.Collections.Generic.Queue[object]'
  $rootHandle = [int64]$Root.Current.NativeWindowHandle
  $rootTitle = [string]$Root.Current.Name
  $queue.Enqueue([pscustomobject]@{ Element = $Root; Depth = 0; Path = "0" })
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker

  while ($queue.Count -gt 0 -and $items.Count -lt $MaxElements) {
    $node = $queue.Dequeue()
    try {
      $info = Get-HiroElementInfo $node.Element $node.Depth $node.Path $rootHandle $rootTitle
      if (Test-HiroElementMatches $info $Query) {
        $items.Add($info) | Out-Null
      }

      if ($node.Depth -ge $MaxDepth) { continue }
      $child = $walker.GetFirstChild($node.Element)
      $index = 0
      while ($null -ne $child -and ($queue.Count + $items.Count) -lt ($MaxElements * 4)) {
        $queue.Enqueue([pscustomobject]@{
          Element = $child
          Depth = ($node.Depth + 1)
          Path = "$($node.Path).$index"
        })
        $child = $walker.GetNextSibling($child)
        $index += 1
      }
    } catch {
    }
  }

  return $items
}

function Find-HiroElement {
  param([object]$Root, [object]$Locator)
  if ($null -eq $Locator) { return $null }

  $targetRuntimeId = [string](Get-HiroProperty $Locator "runtimeId")
  $targetPath = [string](Get-HiroProperty $Locator "path")
  $targetAutomationId = [string](Get-HiroProperty $Locator "automationId")
  $targetName = [string](Get-HiroProperty $Locator "name")
  $targetControlType = [string](Get-HiroProperty $Locator "controlType")
  $targetClassName = [string](Get-HiroProperty $Locator "className")

  $queue = New-Object 'System.Collections.Generic.Queue[object]'
  $queue.Enqueue([pscustomobject]@{ Element = $Root; Depth = 0; Path = "0" })
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $bestElement = $null
  $bestScore = 0
  $visited = 0

  while ($queue.Count -gt 0 -and $visited -lt 1500) {
    $visited += 1
    $node = $queue.Dequeue()
    try {
      $info = Get-HiroElementInfo $node.Element $node.Depth $node.Path ([int64]$Root.Current.NativeWindowHandle) ([string]$Root.Current.Name)
      if ($targetRuntimeId -and $info.runtimeId -eq $targetRuntimeId) { return $node.Element }
      if ($targetPath -and $info.path -eq $targetPath) {
        $bestElement = $node.Element
        $bestScore = [Math]::Max($bestScore, 60)
      }

      $score = 0
      if ($targetAutomationId -and $info.automationId -eq $targetAutomationId) { $score += 100 }
      if ($targetName) {
        if ($info.name -eq $targetName) { $score += 80 }
        elseif ([string]$info.name -and ([string]$info.name).ToLowerInvariant().Contains($targetName.ToLowerInvariant())) { $score += 40 }
      }
      if ($targetControlType -and $info.controlType -eq $targetControlType) { $score += 25 }
      if ($targetClassName -and $info.className -eq $targetClassName) { $score += 10 }

      if ($score -gt $bestScore) {
        $bestScore = $score
        $bestElement = $node.Element
      }

      $child = $walker.GetFirstChild($node.Element)
      $index = 0
      while ($null -ne $child -and $visited -lt 1500) {
        $queue.Enqueue([pscustomobject]@{
          Element = $child
          Depth = ($node.Depth + 1)
          Path = "$($node.Path).$index"
        })
        $child = $walker.GetNextSibling($child)
        $index += 1
      }
    } catch {
    }
  }

  if ($bestScore -gt 0) { return $bestElement }
  return $null
}

function Invoke-HiroElement {
  param([object]$Element)

  $pattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    $pattern.Invoke()
    Start-Sleep -Milliseconds 150
    return "InvokePattern"
  }
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
    $pattern.Select()
    Start-Sleep -Milliseconds 150
    return "SelectionItemPattern"
  }
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$pattern)) {
    $pattern.Toggle()
    Start-Sleep -Milliseconds 150
    return "TogglePattern"
  }
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) {
    if ($pattern.Current.ExpandCollapseState -eq [System.Windows.Automation.ExpandCollapseState]::Collapsed) {
      $pattern.Expand()
      Start-Sleep -Milliseconds 150
      return "ExpandCollapsePattern.Expand"
    }
    $pattern.Collapse()
    Start-Sleep -Milliseconds 150
    return "ExpandCollapsePattern.Collapse"
  }

  $Element.SetFocus()
  Start-Sleep -Milliseconds 100
  return "SetFocus"
}

function Send-HiroKeys {
  param([string]$SendKeys)
  if (-not $SendKeys) { throw "SendKeys payload is required." }
  try {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    [System.Windows.Forms.SendKeys]::SendWait($SendKeys)
    Start-Sleep -Milliseconds 100
    return
  } catch {
    $shell = New-Object -ComObject WScript.Shell
    $shell.SendKeys($SendKeys)
    Start-Sleep -Milliseconds 100
  }
}

function Set-HiroText {
  param([object]$Element, [string]$Text)
  $pattern = $null
  if ($Element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
    if (-not $pattern.Current.IsReadOnly) {
      $pattern.SetValue($Text)
      Start-Sleep -Milliseconds 100
      return "ValuePattern"
    }
  }

  $Element.SetFocus()
  Start-Sleep -Milliseconds 80
  Set-Clipboard -Value $Text
  Send-HiroKeys "^a"
  Send-HiroKeys "^v"
  return "ClipboardPaste"
}

function Focus-HiroWindow {
  param([object]$Window)
  $handle = [int64]$Window.Current.NativeWindowHandle
  if ($handle -gt 0) {
    [HiroNativeWin32]::ShowWindowAsync([IntPtr]::new($handle), 9) | Out-Null
    [HiroNativeWin32]::SetForegroundWindow([IntPtr]::new($handle)) | Out-Null
  }
  try { $Window.SetFocus() } catch {}
  Start-Sleep -Milliseconds 150
  return Get-HiroElementInfo $Window 0 "focused" $handle $Window.Current.Name
}

function Click-HiroAt {
  param([int]$X, [int]$Y, [string]$Button = "left", [bool]$DoubleClick = $false)
  [HiroNativeWin32]::SetCursorPos($X, $Y) | Out-Null
  Start-Sleep -Milliseconds 50

  $down = 0x0002 # MOUSEEVENTF_LEFTDOWN
  $up   = 0x0004 # MOUSEEVENTF_LEFTUP
  if ($Button -eq "right") {
    $down = 0x0008
    $up   = 0x0010
  } elseif ($Button -eq "middle") {
    $down = 0x0020
    $up   = 0x0040
  }

  [HiroNativeWin32]::mouse_event([uint32]$down, 0, 0, 0, [UIntPtr]::Zero)
  [HiroNativeWin32]::mouse_event([uint32]$up, 0, 0, 0, [UIntPtr]::Zero)

  if ($DoubleClick) {
    Start-Sleep -Milliseconds 80
    [HiroNativeWin32]::mouse_event([uint32]$down, 0, 0, 0, [UIntPtr]::Zero)
    [HiroNativeWin32]::mouse_event([uint32]$up, 0, 0, 0, [UIntPtr]::Zero)
  }
  Start-Sleep -Milliseconds 100
}

function Drag-HiroMouse {
  param([int]$FromX, [int]$FromY, [int]$ToX, [int]$ToY)
  [HiroNativeWin32]::SetCursorPos($FromX, $FromY) | Out-Null
  Start-Sleep -Milliseconds 50
  [HiroNativeWin32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) # Left down
  Start-Sleep -Milliseconds 100

  $steps = 15
  for ($i = 1; $i -le $steps; $i++) {
    $currX = [int]($FromX + ($ToX - $FromX) * ($i / $steps))
    $currY = [int]($FromY + ($ToY - $FromY) * ($i / $steps))
    [HiroNativeWin32]::SetCursorPos($currX, $currY) | Out-Null
    Start-Sleep -Milliseconds 15
  }

  [HiroNativeWin32]::SetCursorPos($ToX, $ToY) | Out-Null
  Start-Sleep -Milliseconds 50
  [HiroNativeWin32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) # Left up
  Start-Sleep -Milliseconds 100
}

function Scroll-HiroMouse {
  param([string]$Direction = "down", [int]$Amount = 3)
  $clicks = if ($Amount -gt 0) { $Amount } else { 3 }
  $delta = if ($Direction -eq "up" -or $Direction -eq "left") { 120 * $clicks } else { -120 * $clicks }
  [HiroNativeWin32]::mouse_event(0x0800, 0, 0, [uint32]$delta, [UIntPtr]::Zero) # MOUSEEVENTF_WHEEL
  Start-Sleep -Milliseconds 100
}

function Invoke-HiroComputer {
  param([string]$PayloadJson)

  try {
    Initialize-HiroComputer
    $payload = $PayloadJson | ConvertFrom-Json
    $action = [string]$payload.action

    if ($action -eq "observe") {
      $maxElements = [int](Get-HiroProperty $payload "maxElements")
      if ($maxElements -le 0) { $maxElements = 80 }
      if ($maxElements -gt 300) { $maxElements = 300 }
      $query = [string](Get-HiroProperty $payload "query")
      $root = Find-HiroWindow $payload
      if ($null -eq $root) { throw "No target window could be resolved." }
      $target = Get-HiroElementInfo $root 0 "target" ([int64]$root.Current.NativeWindowHandle) ([string]$root.Current.Name)
      $elements = Get-HiroElementTree $root $maxElements $query 6
      return New-HiroResult $true $action ([ordered]@{
        activeWindow = Get-HiroActiveWindow
        targetWindow = $target
        topWindows = Get-HiroTopWindows 25
        elements = $elements
        elementCount = $elements.Count
      }) "Observed accessible UI state without mouse input." $null
    }

    if ($action -eq "focus") {
      $window = Find-HiroWindow $payload
      if ($null -eq $window) { throw "No target window could be resolved." }
      return New-HiroResult $true $action (Focus-HiroWindow $window) "Focused window without mouse input." $null
    }

    if ($action -eq "invoke") {
      $root = Find-HiroWindow $payload.window
      $element = Find-HiroElement $root $payload.locator
      if ($null -eq $element) { throw "No matching UI element was found." }
      $method = Invoke-HiroElement $element
      return New-HiroResult $true $action ([ordered]@{
        method = $method
        element = Get-HiroElementInfo $element 0 "invoked" ([int64]$root.Current.NativeWindowHandle) ([string]$root.Current.Name)
      }) "Invoked UI element through accessibility patterns." $null
    }

    if ($action -eq "set_text") {
      $root = Find-HiroWindow $payload.window
      $element = Find-HiroElement $root $payload.locator
      if ($null -eq $element) { throw "No matching text-capable UI element was found." }
      $method = Set-HiroText $element ([string]$payload.text)
      return New-HiroResult $true $action ([ordered]@{
        method = $method
        element = Get-HiroElementInfo $element 0 "set_text" ([int64]$root.Current.NativeWindowHandle) ([string]$root.Current.Name)
      }) "Set UI text without mouse input." $null
    }

    if ($action -eq "hotkey") {
      if ($payload.window) {
        $window = Find-HiroWindow $payload.window
        if ($null -ne $window) { Focus-HiroWindow $window | Out-Null }
      }
      Send-HiroKeys ([string]$payload.sendKeys)
      return New-HiroResult $true $action ([ordered]@{ sendKeys = [string]$payload.sendKeys }) "Sent keyboard shortcut without mouse input." $null
    }

    if ($action -eq "clipboard_set") {
      Set-Clipboard -Value ([string]$payload.text)
      return New-HiroResult $true $action ([ordered]@{ length = ([string]$payload.text).Length }) "Clipboard updated." $null
    }

    if ($action -eq "clipboard_get") {
      $value = Get-Clipboard -Raw
      return New-HiroResult $true $action ([ordered]@{ text = [string]$value }) "Clipboard read." $null
    }

    if ($action -eq "clipboard_clear") {
      Set-Clipboard -Value ""
      return New-HiroResult $true $action ([ordered]@{ length = 0 }) "Clipboard cleared." $null
    }

    if ($action -eq "screenshot") {
      Add-Type -AssemblyName System.Windows.Forms | Out-Null
      $screen = [System.Windows.Forms.Screen]::PrimaryScreen
      $bounds = $screen.Bounds
      $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)
      $graphics.Dispose()
      $tempPath = [System.IO.Path]::GetTempFileName() + ".png"
      $bitmap.Save($tempPath, [System.Drawing.Imaging.ImageFormat]::Png)
      $bitmap.Dispose()
      $base64 = [System.Convert]::ToBase64String([System.IO.File]::ReadAllBytes($tempPath))
      Remove-Item -LiteralPath $tempPath -Force -ErrorAction SilentlyContinue
      return New-HiroResult $true $action ([ordered]@{
        screenshot = $base64
        width = $bounds.Width
        height = $bounds.Height
        format = "png"
      }) "Captured screenshot without mouse input." $null
    }

    if ($action -eq "list_processes") {
      $processes = Get-Process | Sort-Object CPU -Descending | Select-Object -First 100 | ForEach-Object {
        [ordered]@{
          pid = $_.Id
          name = $_.ProcessName
          cpu = [math]::Round($_.CPU, 1)
          memoryMB = [math]::Round($_.WorkingSet64 / 1MB, 1)
          startTime = if ($_.StartTime) { $_.StartTime.ToString("yyyy-MM-dd HH:mm:ss") } else { "" }
        }
      }
      return New-HiroResult $true $action ([ordered]@{ processes = @($processes); count = $processes.Count }) "Listed top processes." $null
    }

    if ($action -eq "get_system_info") {
      $os = Get-CimInstance Win32_OperatingSystem
      $computer = Get-CimInstance Win32_ComputerSystem
      return New-HiroResult $true $action ([ordered]@{
        os = [string]$os.Caption
        version = [string]$os.Version
        architecture = [string]$os.OSArchitecture
        totalMemoryGB = [math]::Round($computer.TotalPhysicalMemory / 1GB, 1)
        manufacturer = [string]$computer.Manufacturer
        model = [string]$computer.Model
        processors = [int]$computer.NumberOfProcessors
        logicalProcessors = [int]$computer.NumberOfLogicalProcessors
      }) "Retrieved system information." $null
    }

    if ($action -eq "list_displays") {
      Add-Type -AssemblyName System.Windows.Forms | Out-Null
      $displays = [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
        [ordered]@{
          deviceName = $_.DeviceName
          primary = $_.Primary
          bounds = "{0}x{1}+{2}+{3}" -f $_.Bounds.Width, $_.Bounds.Height, $_.Bounds.X, $_.Bounds.Y
          workingArea = "{0}x{1}+{2}+{3}" -f $_.WorkingArea.Width, $_.WorkingArea.Height, $_.WorkingArea.X, $_.WorkingArea.Y
        }
      }
      return New-HiroResult $true $action ([ordered]@{ displays = @($displays); count = $displays.Count }) "Listed display information." $null
    }

    if ($action -eq "list_windows") {
      $windows = @()
      try {
        Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -ne "" } | ForEach-Object {
          $rect = [ordered]@{ left=0; top=0; width=0; height=0 }
          try {
            $handle = $_.MainWindowHandle
            $element = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
            if ($null -ne $element) {
              $r = $element.Current.BoundingRectangle
              $rect.left = [int]$r.Left
              $rect.top = [int]$r.Top
              $rect.width = [int]$r.Width
              $rect.height = [int]$r.Height
            }
          } catch {}
          $windows += [ordered]@{
            title = $_.MainWindowTitle
            processName = $_.ProcessName
            pid = $_.Id
            handle = [int64]$_.MainWindowHandle
            bounds = $rect
          }
        }
      } catch {}
      return New-HiroResult $true "list_windows" $windows "Found $($windows.Count) windows" $null
    }

    if ($action -eq "click_at") {
      $x = [int](Get-HiroProperty $payload "x")
      $y = [int](Get-HiroProperty $payload "y")
      $button = [string](Get-HiroProperty $payload "button")
      if (-not $button) { $button = "left" }
      $doubleClick = [bool](Get-HiroProperty $payload "doubleClick")
      Click-HiroAt $x $y $button $doubleClick
      return New-HiroResult $true $action ([ordered]@{ x = $x; y = $y; button = $button; doubleClick = $doubleClick }) "Clicked coordinates ($x, $y)." $null
    }

    if ($action -eq "drag") {
      $fromX = [int](Get-HiroProperty $payload "fromX")
      $fromY = [int](Get-HiroProperty $payload "fromY")
      $toX = [int](Get-HiroProperty $payload "toX")
      $toY = [int](Get-HiroProperty $payload "toY")
      Drag-HiroMouse $fromX $fromY $toX $toY
      return New-HiroResult $true $action ([ordered]@{ fromX = $fromX; fromY = $fromY; toX = $toX; toY = $toY }) "Dragged mouse from ($fromX, $fromY) to ($toX, $toY)." $null
    }

    if ($action -eq "scroll") {
      $direction = [string](Get-HiroProperty $payload "direction")
      if (-not $direction) { $direction = "down" }
      $amount = [int](Get-HiroProperty $payload "amount")
      if ($amount -le 0) { $amount = 3 }
      Scroll-HiroMouse $direction $amount
      return New-HiroResult $true $action ([ordered]@{ direction = $direction; amount = $amount }) "Scrolled $direction by $amount." $null
    }

    if ($action -eq "terminate_app") {
      $targetPid = Get-HiroProperty $payload "pid"
      $processName = [string](Get-HiroProperty $payload "processName")
      $terminated = 0
      if ($targetPid) {
        Stop-Process -Id [int]$targetPid -Force -ErrorAction Stop
        $terminated = 1
      } elseif ($processName) {
        $procs = Get-Process -Name $processName -ErrorAction SilentlyContinue
        if ($procs) {
          $procs | Stop-Process -Force -ErrorAction Stop
          $terminated = $procs.Count
        }
      } else {
        throw "pid or processName is required to terminate application."
      }
      return New-HiroResult $true $action ([ordered]@{ pid = $targetPid; processName = $processName; terminatedCount = $terminated }) "Application terminated." $null
    }

    throw "Unsupported computer action: $action"
  } catch {
    return New-HiroResult $false ([string]$action) $null $null $_.Exception.Message
  }
}

$PayloadJson = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($PayloadBase64))
$result = Invoke-HiroComputer -PayloadJson $PayloadJson
$result | ConvertTo-Json -Depth 16 -Compress
`;

function execFileText(
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer: number },
): Promise<ExecFileResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      },
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function sanitizeMaxElements(value: unknown): number {
  const numeric = asNumber(value);
  if (numeric == null) return 80;
  return Math.max(1, Math.min(300, Math.floor(numeric)));
}

function normalizeLaunchArgs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getWindowTarget(args: Record<string, unknown>): ComputerWindowTarget {
  const target: ComputerWindowTarget = {};
  const windowHandle = asNumber(args["window_handle"] ?? args["windowHandle"]);
  if (windowHandle != null) target.windowHandle = Math.floor(windowHandle);
  const windowTitle = asString(args["window_title"] ?? args["windowTitle"]);
  if (windowTitle) target.windowTitle = windowTitle;
  const processName = asString(args["process_name"] ?? args["processName"]);
  if (processName) target.processName = processName;
  return target;
}

function normalizeControlType(value: unknown): string | undefined {
  const controlType = asString(value);
  if (!controlType) return undefined;
  return controlType.replace(/^ControlType\./i, "");
}

export function normalizeHotkeyForSendKeys(keys: unknown): string {
  const rawParts = Array.isArray(keys)
    ? keys
    : typeof keys === "string"
      ? keys.split("+")
      : [];
  const parts = rawParts
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    throw new Error("keys must be a string like 'Ctrl+S' or an array of keys.");
  }

  let modifiers = "";
  let primary = "";
  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (normalized === "ctrl" || normalized === "control") {
      modifiers += "^";
      continue;
    }
    if (normalized === "alt" || normalized === "option") {
      modifiers += "%";
      continue;
    }
    if (normalized === "shift") {
      modifiers += "+";
      continue;
    }
    if (
      normalized === "win" ||
      normalized === "windows" ||
      normalized === "meta"
    ) {
      throw new Error(
        "Windows/meta key shortcuts are not supported by this mouse-free keyboard backend.",
      );
    }
    primary = part;
  }

  if (!primary) {
    throw new Error("A non-modifier key is required.");
  }

  const keyMap: Record<string, string> = {
    enter: "{ENTER}",
    return: "{ENTER}",
    tab: "{TAB}",
    escape: "{ESC}",
    esc: "{ESC}",
    backspace: "{BACKSPACE}",
    delete: "{DELETE}",
    del: "{DELETE}",
    insert: "{INSERT}",
    home: "{HOME}",
    end: "{END}",
    pageup: "{PGUP}",
    pagedown: "{PGDN}",
    pgup: "{PGUP}",
    pgdn: "{PGDN}",
    up: "{UP}",
    down: "{DOWN}",
    left: "{LEFT}",
    right: "{RIGHT}",
    space: " ",
  };

  const lowerPrimary = primary.toLowerCase();
  const functionMatch = /^f([1-9]|1[0-9]|2[0-4])$/i.exec(primary);
  const sendKey =
    keyMap[lowerPrimary] ||
    (functionMatch
      ? `{${primary.toUpperCase()}}`
      : primary.length === 1
        ? primary
        : `{${primary.toUpperCase()}}`);

  return `${modifiers}${sendKey}`;
}

export class ComputerAgent {
  private readonly timeoutMs: number;
  private elementCache = new Map<string, ComputerElementLocator>();
  private elementSequence = 0;
  private static scriptPath: string | null = null;

  constructor(timeoutMs: number = 30_000) {
    this.timeoutMs = timeoutMs;
  }

  private formatResult(result: ComputerPowerShellResult): string {
    return JSON.stringify(result, null, 2);
  }

  private formatError(action: string, error: unknown): string {
    return this.formatResult({
      ok: false,
      action,
      error: getErrorMessage(error),
    });
  }

  private async runPowerShell<T>(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<ComputerPowerShellResult<T>> {
    if (process.platform !== "win32") {
      return {
        ok: false,
        action,
        error: "computer_use currently supports Windows UI Automation only.",
      };
    }

    const payloadText = JSON.stringify({ action, ...payload });
    const payloadBase64 = Buffer.from(payloadText, "utf8").toString("base64");
    const scriptPath = this.ensurePowerShellScript();
    const shell = process.env["Hiro_POWERSHELL"] || "powershell.exe";

    const result = await execFileText(
      shell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        scriptPath,
        "-PayloadBase64",
        payloadBase64,
      ],
      { timeout: this.timeoutMs, maxBuffer: 6 * 1024 * 1024 },
    );
    const output = result.stdout.trim();
    if (!output) {
      throw new Error(
        result.stderr.trim() ||
          "PowerShell computer action returned no output.",
      );
    }
    return JSON.parse(output) as ComputerPowerShellResult<T>;
  }

  private ensurePowerShellScript(): string {
    if (ComputerAgent.scriptPath) return ComputerAgent.scriptPath;
    const scriptPath = path.join(os.tmpdir(), "Hiro-computer-agent.ps1");
    try {
      const current = fs.existsSync(scriptPath)
        ? fs.readFileSync(scriptPath, "utf-8")
        : "";
      if (current !== COMPUTER_POWERSHELL_SCRIPT) {
        fs.writeFileSync(scriptPath, COMPUTER_POWERSHELL_SCRIPT, "utf-8");
      }
    } catch (err) {
      throw new Error(
        `Failed to prepare computer-use PowerShell sidecar: ${getErrorMessage(err)}`,
      );
    }
    ComputerAgent.scriptPath = scriptPath;
    return scriptPath;
  }

  private rememberElements(data: ComputerObserveData): ComputerObserveData {
    const elements = Array.isArray(data.elements) ? data.elements : [];
    const mapped = elements.map((element) => {
      const id = `computer_${++this.elementSequence}`;
      const locator: ComputerElementLocator = {
        id,
        name: asString(element["name"]),
        automationId: asString(element["automationId"]),
        controlType: normalizeControlType(element["controlType"]),
        className: asString(element["className"]),
        runtimeId: asString(element["runtimeId"]),
        path: asString(element["path"]),
        windowHandle: asNumber(element["windowHandle"]),
        windowTitle: asString(element["windowTitle"]),
        processName: asString(element["processName"]),
      };
      this.elementCache.set(id, locator);
      return { id, ...element };
    });

    return { ...data, elements: mapped, elementCount: mapped.length };
  }

  private locatorFromArgs(
    args: Record<string, unknown>,
  ): ComputerElementLocator {
    const elementId = asString(args["element_id"] ?? args["elementId"]);
    if (elementId) {
      const cached = this.elementCache.get(elementId);
      if (!cached) {
        throw new Error(
          `Unknown element_id '${elementId}'. Call computer_observe first or pass name/automation_id/control_type.`,
        );
      }
      return cached;
    }

    const locator: ComputerElementLocator = {
      name: asString(args["name"] ?? args["text"] ?? args["label"]),
      automationId: asString(args["automation_id"] ?? args["automationId"]),
      controlType: normalizeControlType(
        args["control_type"] ?? args["controlType"] ?? args["role"],
      ),
      className: asString(args["class_name"] ?? args["className"]),
      runtimeId: asString(args["runtime_id"] ?? args["runtimeId"]),
      path: asString(args["path"]),
      ...getWindowTarget(args),
    };

    if (
      !locator.name &&
      !locator.automationId &&
      !locator.controlType &&
      !locator.className &&
      !locator.runtimeId &&
      !locator.path
    ) {
      throw new Error(
        "A target element is required. Pass element_id from computer_observe, or name/automation_id/control_type.",
      );
    }
    return locator;
  }

  async observe(args: Record<string, unknown>): Promise<string> {
    try {
      const options: ComputerObserveOptions = {
        ...getWindowTarget(args),
        activeOnly: Boolean(args["active_only"] ?? args["activeOnly"]),
        maxElements: sanitizeMaxElements(
          args["max_elements"] ?? args["maxElements"],
        ),
        query: asString(args["query"]),
      };
      const result = await this.runPowerShell<ComputerObserveData>(
        "observe",
        options as Record<string, unknown>,
      );
      if (result.ok && isRecord(result.data)) {
        result.data = this.rememberElements(
          result.data as ComputerObserveData,
        ) as ComputerObserveData;
      }
      return this.formatResult(result);
    } catch (err) {
      return this.formatError("observe", err);
    }
  }

  async focus(args: Record<string, unknown>): Promise<string> {
    try {
      const result = await this.runPowerShell("focus", {
        ...getWindowTarget(args),
      });
      return this.formatResult(result);
    } catch (err) {
      return this.formatError("focus", err);
    }
  }

  async invoke(args: Record<string, unknown>): Promise<string> {
    try {
      const result = await this.runPowerShell("invoke", {
        window: getWindowTarget(args),
        locator: this.locatorFromArgs(args),
      });
      return this.formatResult(result);
    } catch (err) {
      return this.formatError("invoke", err);
    }
  }

  async setText(args: Record<string, unknown>): Promise<string> {
    try {
      const text = typeof args["text"] === "string" ? args["text"] : undefined;
      if (text == null) throw new Error("text is required.");
      const result = await this.runPowerShell("set_text", {
        window: getWindowTarget(args),
        locator: this.locatorFromArgs(args),
        text,
      });
      return this.formatResult(result);
    } catch (err) {
      return this.formatError("set_text", err);
    }
  }

  async hotkey(args: Record<string, unknown>): Promise<string> {
    try {
      const keys = args["keys"] ?? args["key"];
      const sendKeys = normalizeHotkeyForSendKeys(keys);
      const result = await this.runPowerShell("hotkey", {
        window: getWindowTarget(args),
        sendKeys,
      });
      return this.formatResult(result);
    } catch (err) {
      return this.formatError("hotkey", err);
    }
  }

  async clipboard(args: Record<string, unknown>): Promise<string> {
    try {
      const action = asString(args["action"]) || "get";
      if (action === "set") {
        const text = typeof args["text"] === "string" ? args["text"] : "";
        return this.formatResult(
          await this.runPowerShell("clipboard_set", { text }),
        );
      }
      if (action === "clear") {
        return this.formatResult(
          await this.runPowerShell("clipboard_clear", {}),
        );
      }
      if (action === "get") {
        return this.formatResult(await this.runPowerShell("clipboard_get", {}));
      }
      throw new Error("clipboard action must be one of: get, set, clear.");
    } catch (err) {
      return this.formatError("clipboard", err);
    }
  }

  async launch(args: Record<string, unknown>): Promise<string> {
    try {
      const command = asString(args["command"] ?? args["app"] ?? args["path"]);
      if (!command) throw new Error("command is required.");
      const launchArgs = normalizeLaunchArgs(args["args"]);
      const cwd = asString(args["working_dir"] ?? args["workingDir"]);
      const workingDir = cwd
        ? path.isAbsolute(cwd)
          ? cwd
          : path.resolve(cwd)
        : process.cwd();
      const child = spawn(command, launchArgs, {
        cwd: workingDir,
        detached: true,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
      child.unref();
      return this.formatResult({
        ok: true,
        action: "launch",
        data: {
          command,
          args: launchArgs,
          pid: child.pid,
          workingDir,
        },
        message: "Application launched without shell command interpretation.",
      });
    } catch (err) {
      return this.formatError("launch", err);
    }
  }

  async screenshot(args: Record<string, unknown> = {}): Promise<string> {
    try {
      const result = await this.runPowerShell<{
        screenshot: string;
        width: number;
        height: number;
        format: string;
      }>("screenshot", {});
      const showGrid = Boolean(
        args["grid"] ?? args["draw_grid"] ?? args["drawGrid"],
      );
      if (showGrid && result.ok && result.data?.screenshot) {
        try {
          const { drawGridOverlay } = await import("./computer-grid.js");
          const rawPng = Buffer.from(result.data.screenshot, "base64");
          // Superimpose grid overlay
          const gridStep =
            typeof args["grid_step"] === "number" ? args["grid_step"] : 100;
          const gridPng = drawGridOverlay(
            rawPng,
            result.data.width,
            result.data.height,
            gridStep,
          );
          result.data.screenshot = gridPng.toString("base64");
        } catch {
          // If grid drawing fails, return clean screenshot
        }
      }
      return this.formatResult(result);
    } catch (err) {
      return this.formatError("screenshot", err);
    }
  }

  async clickAt(args: Record<string, unknown>): Promise<string> {
    try {
      const x = asNumber(args["x"]);
      const y = asNumber(args["y"]);
      if (x == null || y == null)
        throw new Error("x and y coordinates are required.");
      const button = asString(args["button"]) || "left";
      const doubleClick = Boolean(args["double_click"] ?? args["doubleClick"]);
      const result = await this.runPowerShell("click_at", {
        x: Math.round(x),
        y: Math.round(y),
        button,
        doubleClick,
      });
      return this.formatResult(result);
    } catch (err) {
      return this.formatError("click_at", err);
    }
  }

  async drag(args: Record<string, unknown>): Promise<string> {
    try {
      const fromX = asNumber(args["from_x"] ?? args["fromX"] ?? args["x1"]);
      const fromY = asNumber(args["from_y"] ?? args["fromY"] ?? args["y1"]);
      const toX = asNumber(args["to_x"] ?? args["toX"] ?? args["x2"]);
      const toY = asNumber(args["to_y"] ?? args["toY"] ?? args["y2"]);
      if (fromX == null || fromY == null || toX == null || toY == null) {
        throw new Error("from_x, from_y, to_x, to_y are required for drag.");
      }
      const result = await this.runPowerShell("drag", {
        fromX: Math.round(fromX),
        fromY: Math.round(fromY),
        toX: Math.round(toX),
        toY: Math.round(toY),
      });
      return this.formatResult(result);
    } catch (err) {
      return this.formatError("drag", err);
    }
  }

  async scroll(args: Record<string, unknown>): Promise<string> {
    try {
      const direction = asString(args["direction"]) || "down";
      const amount = asNumber(args["amount"]) || 3;
      const result = await this.runPowerShell("scroll", {
        direction,
        amount: Math.round(amount),
      });
      return this.formatResult(result);
    } catch (err) {
      return this.formatError("scroll", err);
    }
  }

  async terminateApp(args: Record<string, unknown>): Promise<string> {
    try {
      const pid = asNumber(args["pid"]);
      const processName = asString(
        args["process_name"] ?? args["processName"] ?? args["app"],
      );
      if (pid == null && !processName) {
        throw new Error("pid or process_name is required.");
      }
      const result = await this.runPowerShell("terminate_app", {
        pid,
        processName,
      });
      return this.formatResult(result);
    } catch (err) {
      return this.formatError("terminate_app", err);
    }
  }

  async listProcesses(_args: Record<string, unknown>): Promise<string> {
    try {
      const result = await this.runPowerShell("list_processes", {});
      return this.formatResult(result);
    } catch (err) {
      return this.formatError("list_processes", err);
    }
  }

  async getSystemInfo(_args: Record<string, unknown>): Promise<string> {
    try {
      const result = await this.runPowerShell("get_system_info", {});
      return this.formatResult(result);
    } catch (err) {
      return this.formatError("get_system_info", err);
    }
  }

  async listDisplays(_args: Record<string, unknown>): Promise<string> {
    try {
      const result = await this.runPowerShell("list_displays", {});
      return this.formatResult(result);
    } catch (err) {
      return this.formatError("list_displays", err);
    }
  }

  /**
   * Lists all visible windows with their titles, process names, handles, and bounds.
   */
  public async listWindows(_args: Record<string, unknown>): Promise<string> {
    if (process.platform === "win32") {
      return this.formatResult(await this.runPowerShell("list_windows", {}));
    }
    if (process.platform === "linux") {
      try {
        const { stdout } = await execFileText("wmctrl", ["-l", "-p"], {
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        });
        return JSON.stringify({
          ok: true,
          action: "list_windows",
          data: stdout.trim(),
        });
      } catch {
        try {
          const { stdout } = await execFileText(
            "xdotool",
            ["search", "--onlyvisible", "--name", ""],
            { timeout: 15000, maxBuffer: 1024 * 1024 },
          );
          return JSON.stringify({
            ok: true,
            action: "list_windows",
            data: stdout.trim(),
          });
        } catch {
          return JSON.stringify({
            ok: false,
            action: "list_windows",
            error: "wmctrl and xdotool not available",
          });
        }
      }
    }
    if (process.platform === "darwin") {
      try {
        const script = `tell application "System Events" to get {name, title} of every process whose visible is true`;
        const { stdout } = await execFileText("osascript", ["-e", script], {
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        });
        return JSON.stringify({
          ok: true,
          action: "list_windows",
          data: stdout.trim(),
        });
      } catch (e) {
        return JSON.stringify({
          ok: false,
          action: "list_windows",
          error: String(e),
        });
      }
    }
    return JSON.stringify({
      ok: false,
      action: "list_windows",
      error: "Unsupported platform",
    });
  }

  async verify(args: Record<string, unknown>): Promise<string> {
    try {
      const contains = asString(args["contains"] ?? args["text"]);
      const notContains = asString(args["not_contains"] ?? args["notContains"]);
      if (!contains && !notContains) {
        throw new Error("contains or not_contains is required.");
      }
      const observationText = await this.observe({
        ...args,
        max_elements: sanitizeMaxElements(args["max_elements"] ?? 120),
      });
      const observation = JSON.parse(
        observationText,
      ) as ComputerPowerShellResult<ComputerObserveData>;
      const corpus = JSON.stringify(observation.data || {}).toLowerCase();
      const containsOk = contains
        ? corpus.includes(contains.toLowerCase())
        : true;
      const notContainsOk = notContains
        ? !corpus.includes(notContains.toLowerCase())
        : true;
      return this.formatResult({
        ok: containsOk && notContainsOk,
        action: "verify",
        data: {
          contains,
          notContains,
          containsOk,
          notContainsOk,
          activeWindow: observation.data?.activeWindow,
          targetWindow: observation.data?.targetWindow,
        },
        message:
          containsOk && notContainsOk
            ? "Verification passed against accessible UI state."
            : "Verification failed against accessible UI state.",
      });
    } catch (err) {
      return this.formatError("verify", err);
    }
  }
}

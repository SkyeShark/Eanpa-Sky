# Show only the existing owned review browser. No browser process is launched.
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskSession = Get-Content -LiteralPath (Join-Path $taskRoot '.artifacts/overhaul-20260906/processes.json') -Raw | ConvertFrom-Json
if ($taskSession.headless) { throw 'Switch the owned browser to review mode first.' }
$taskBrowser = Get-CimInstance Win32_Process -Filter "ProcessId = $($taskSession.browserPid)"
if (-not $taskBrowser -or $taskBrowser.CommandLine -notlike "*$($taskSession.profile)*" -or $taskBrowser.CommandLine -like '*--headless*') {
    throw 'Owned visible-browser identity could not be verified.'
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class EanpaReviewWindowInfo { public long Handle; public string ClassName; public bool WasVisible; public bool Visible; public bool Foreground; }
public static class EanpaReviewWindow {
 delegate bool EnumProc(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder name, int size);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int command);
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
 public static EanpaReviewWindowInfo[] Show(uint pid) {
  var result=new List<EanpaReviewWindowInfo>();
  EnumWindows((h,p)=>{uint owner;GetWindowThreadProcessId(h,out owner);if(owner!=pid)return true;
   var name=new StringBuilder(256);GetClassName(h,name,256);if(name.ToString()!="Chrome_WidgetWin_1")return true;
   var info=new EanpaReviewWindowInfo{Handle=h.ToInt64(),ClassName=name.ToString(),WasVisible=IsWindowVisible(h)};
   ShowWindowAsync(h,9);ShowWindowAsync(h,5);info.Foreground=SetForegroundWindow(h);info.Visible=IsWindowVisible(h);result.Add(info);return true;
  },IntPtr.Zero);return result.ToArray();
 }
}
'@
$taskWindows = @([EanpaReviewWindow]::Show([uint32]$taskSession.browserPid))
if (-not $taskWindows.Count) { throw 'The owned Chrome process has no top-level review window.' }
$taskWindows | ConvertTo-Json -Compress

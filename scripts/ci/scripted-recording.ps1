# Records ~8 s with the native recorder while driving the mouse and keyboard, so the bundle has
# known content: 3 clicks, a drag and some typing. Usage: scripted-recording.ps1 <recorder.exe> <bundleDir>
param([string]$Recorder, [string]$Bundle)
$ErrorActionPreference = 'Stop'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Input {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint f, UIntPtr e);
  public static void Click() { mouse_event(0x02, 0, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(60); mouse_event(0x04, 0, 0, 0, UIntPtr.Zero); }
  public static void Key(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(30); keybd_event(vk, 0, 2, UIntPtr.Zero); }
}
"@

New-Item -ItemType Directory -Force -Path "$Bundle\recording" | Out-Null
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $Recorder
$psi.Arguments = "record --out `"$Bundle\recording`" --monitor 0"
$psi.RedirectStandardInput = $true
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$psi.UseShellExecute = $false
$p = [System.Diagnostics.Process]::Start($psi)

# Log lines may come before "started"; read until started or error.
while ($true) {
  $line = $p.StandardOutput.ReadLine()
  if ($null -eq $line) { throw "Recorder exited before starting: $($p.StandardError.ReadToEnd())" }
  Write-Host "recorder: $line"
  if ($line -match '"error"') { throw "Recorder failed: $line" }
  if ($line -match '"started"') { break }
}

function Glide($x0, $y0, $x1, $y1, $steps) {
  for ($i = 0; $i -le $steps; $i++) {
    [Input]::SetCursorPos([int]($x0 + ($x1 - $x0) * $i / $steps), [int]($y0 + ($y1 - $y0) * $i / $steps)) | Out-Null
    Start-Sleep -Milliseconds 12
  }
}

Glide 100 100 600 400 60; [Input]::Click(); Start-Sleep -Milliseconds 700
Glide 600 400 900 300 50; [Input]::Click(); Start-Sleep -Milliseconds 700
foreach ($vk in 0x48, 0x45, 0x4C, 0x4C, 0x4F) { [Input]::Key($vk); Start-Sleep -Milliseconds 90 }
Glide 900 300 300 600 70; [Input]::Click(); Start-Sleep -Milliseconds 900
# Drag
[Input]::SetCursorPos(400, 500) | Out-Null; [Input]::mouse_event(0x02, 0, 0, 0, [UIntPtr]::Zero)
Glide 400 500 700 650 40; [Input]::mouse_event(0x04, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Seconds 2

$p.StandardInput.WriteLine("stop")
$rest = $p.StandardOutput.ReadToEnd()
Write-Host "recorder: $rest"
$p.WaitForExit(30000) | Out-Null
if ($p.ExitCode -ne 0) { throw "Recorder exited with $($p.ExitCode)" }

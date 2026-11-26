# Install Piano Falls into a stable folder and create a desktop shortcut with a generated icon.
# ASCII only (PowerShell 5.1 parses BOM-less UTF-8 as ANSI, so non-ASCII comments break it).
#
#   powershell -ExecutionPolicy Bypass -File tools\install-shortcut.ps1
#   powershell -ExecutionPolicy Bypass -File tools\install-shortcut.ps1 -Dst "D:\Apps\Piano Falls"
#
# Nothing personal is hard-coded: source defaults to this repo, destination to %LOCALAPPDATA%.
param(
  [string]$Src = '',
  [string]$Dst = '',
  [string]$Desktop = ''
)

$ErrorActionPreference = 'Stop'
if (-not $Src) { $Src = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
if (-not $Dst) { $Dst = Join-Path $env:LOCALAPPDATA 'Piano Falls' }
if (-not $Desktop) { $Desktop = [Environment]::GetFolderPath('Desktop') }

Write-Host "src     $Src"
Write-Host "dst     $Dst"
Write-Host "desktop $Desktop"

if ($Src -ne $Dst) {
  New-Item -ItemType Directory -Path $Dst -Force | Out-Null
  foreach ($name in @('index.html', 'serve.ps1', 'launch.vbs', 'package.json', 'README.md')) {
    $from = Join-Path $Src $name
    if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $Dst -Force }
  }
  foreach ($dir in @('src')) {
    $from = Join-Path $Src $dir
    if (Test-Path -LiteralPath $from) {
      Copy-Item -LiteralPath $from -Destination $Dst -Recurse -Force
    }
  }
}

# Icon: draw a tiny fall-graph so the shortcut does not look like a bare script file.
Add-Type -AssemblyName System.Drawing
$icoPath = Join-Path $Dst 'icon.ico'
$bmp = New-Object System.Drawing.Bitmap 64, 64
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.Clear([System.Drawing.Color]::FromArgb(14, 16, 22))
$brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(96, 178, 255))
for ($i = 0; $i -lt 5; $i++) {
  $x = 6 + $i * 11
  $h = 10 + ($i * 7)
  $g.FillRectangle($brush, $x, 56 - $h, 7, $h)
}
$g.Dispose()
$icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$fs = [System.IO.File]::Create($icoPath)
$icon.Save($fs)
$fs.Dispose()
$bmp.Dispose()

$lnk = Join-Path $Desktop 'Piano Falls.lnk'
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($lnk)
$sc.TargetPath = (Join-Path $Dst '启动 Piano Falls.cmd')
if (-not (Test-Path -LiteralPath $sc.TargetPath)) { $sc.TargetPath = (Join-Path $Dst 'launch.vbs') }
$sc.WorkingDirectory = $Dst
$sc.IconLocation = $icoPath
$sc.Description = 'Piano Falls'
$sc.Save()

Write-Host "ok: $lnk"

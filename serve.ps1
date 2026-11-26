# Piano Falls local static server (PowerShell 5.1, no admin, no runtime deps)
# ASCII only on purpose: PowerShell 5.1 reads .ps1 as ANSI when there is no BOM,
# and non-ASCII comments can then eat the following quote. Keep this file ASCII.
#
# Routes:
#   GET  /            static files under this folder
#   GET  /health      json: whether MuseScore CLI is available
#   POST /convert     body = .mscz bytes -> returns .mid bytes (uses local MuseScore 4 CLI)
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot.TrimEnd('\')
$port = 8765
$url = "http://127.0.0.1:$port/"
$host.UI.RawUI.WindowTitle = "Piano Falls server $port - close this window to stop"
$MaxUpload = 64MB

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.htm'  = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.jpeg' = 'image/jpeg'
  '.webp' = 'image/webp'
  '.ico'  = 'image/x-icon'
  '.wasm' = 'application/wasm'
  '.mid'  = 'audio/midi'
  '.midi' = 'audio/midi'
  '.mp3'  = 'audio/mpeg'
  '.txt'  = 'text/plain; charset=utf-8'
}

# ---- MuseScore 4 CLI detection (used by POST /convert) ----
$msCandidates = @(
  'C:\Program Files\MuseScore 4\bin\MuseScore4.exe',
  'C:\Program Files\MuseScore 4\bin\mscore.exe',
  "$env:LOCALAPPDATA\Programs\MuseScore 4\bin\MuseScore4.exe",
  'C:\Program Files\MuseScore 3\bin\MuseScore3.exe'
)
$msExe = $msCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

function Send-Bytes($stream, [int]$code, [string]$contentType, [byte[]]$body) {
  $status = switch ($code) {
    200 { 'OK' } 400 { 'Bad Request' } 403 { 'Forbidden' } 404 { 'Not Found' }
    405 { 'Method Not Allowed' } 413 { 'Payload Too Large' } 500 { 'Internal Server Error' }
    503 { 'Service Unavailable' } default { 'Error' }
  }
  if ($null -eq $body) { $body = New-Object byte[] 0 }
  $head = "HTTP/1.1 $code $status`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
  $hb = [System.Text.Encoding]::UTF8.GetBytes($head)
  $stream.Write($hb, 0, $hb.Length)
  if ($body.Length -gt 0) { $stream.Write($body, 0, $body.Length) }
  $stream.Flush()
}

function Send-Text($stream, [int]$code, [string]$text) {
  Send-Bytes $stream $code 'text/plain; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes($text))
}

# Read request head + already-buffered body from the socket.
# Returns @{ Ok; Method; Path; Body; Error }
function Read-Request($stream) {
  $ms = New-Object System.IO.MemoryStream
  $buf = New-Object byte[] 8192
  $headerEnd = -1
  while ($true) {
    $n = $stream.Read($buf, 0, $buf.Length)
    if ($n -le 0) { break }
    $ms.Write($buf, 0, $n)
    $arr = $ms.GetBuffer()
    $len = [int]$ms.Length
    for ($i = 3; $i -lt $len; $i++) {
      if ($arr[$i - 3] -eq 13 -and $arr[$i - 2] -eq 10 -and $arr[$i - 1] -eq 13 -and $arr[$i] -eq 10) {
        $headerEnd = $i
        break
      }
    }
    if ($headerEnd -ge 0) { break }
    if ($len -gt 65536) { break }
  }

  if ($headerEnd -lt 0) {
    return @{ Ok = $false; Error = 'incomplete headers' }
  }

  $arr = $ms.GetBuffer()
  $headText = [System.Text.Encoding]::ASCII.GetString($arr, 0, $headerEnd - 3)
  $lines = $headText -split "`r`n"
  $parts = $lines[0] -split ' '
  if ($parts.Length -lt 2) { return @{ Ok = $false; Error = 'bad request line' } }

  $contentLength = 0
  foreach ($l in $lines) {
    if ($l -match '^(?i)content-length:\s*(\d+)') { $contentLength = [int]$matches[1] }
  }
  if ($contentLength -gt $MaxUpload) { return @{ Ok = $false; Error = 'too large' } }

  $got = [int]$ms.Length - ($headerEnd + 1)
  $body = New-Object byte[] $contentLength
  if ($got -gt 0) {
    $copy = [Math]::Min($got, $contentLength)
    [Array]::Copy($arr, $headerEnd + 1, $body, 0, $copy)
    $got = $copy
  }
  while ($got -lt $contentLength) {
    $n = $stream.Read($body, $got, $contentLength - $got)
    if ($n -le 0) { break }
    $got += $n
  }

  return @{ Ok = $true; Method = $parts[0].ToUpper(); Path = $parts[1]; Body = $body }
}

function Convert-MsczToMidi([byte[]]$bytes) {
  if (-not $msExe) { throw 'MuseScore CLI not found' }
  $id = [guid]::NewGuid().ToString('N')
  $in = Join-Path ([IO.Path]::GetTempPath()) "pianofalls_$id.mscz"
  $out = Join-Path ([IO.Path]::GetTempPath()) "pianofalls_$id.mid"
  try {
    [IO.File]::WriteAllBytes($in, $bytes)
    $p = Start-Process -FilePath $msExe -ArgumentList @('-o', "`"$out`"", "`"$in`"") -PassThru -WindowStyle Hidden
    if (-not $p.WaitForExit(90000)) {
      try { $p.Kill() } catch {}
      throw 'MuseScore conversion timed out'
    }
    if (-not (Test-Path -LiteralPath $out)) { throw 'MuseScore produced no output' }
    return [IO.File]::ReadAllBytes($out)
  } finally {
    Remove-Item -LiteralPath $in -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
  }
}

function Patch-AudioSettings([string]$srcPath, [int[]]$mutedTracks) {
  # MuseScore 4 的混音器状态存在 mscz 内的 audiosettings.json（每轨 soloMuteState）。
  # 改这里比删音符安全得多：不动谱面，只让某几轨不出声。
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $dest = "$srcPath.muted.mscz"
  $src = [IO.Compression.ZipFile]::OpenRead($srcPath)
  try {
    $fs = [IO.File]::Open($dest, 'Create')
    $outZip = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
    try {
      foreach ($entry in $src.Entries) {
        $new = $outZip.CreateEntry($entry.FullName, [IO.Compression.CompressionLevel]::Optimal)
        $os = $new.Open()
        if ($entry.FullName -eq 'audiosettings.json') {
          $reader = New-Object IO.StreamReader($entry.Open())
          $json = $reader.ReadToEnd()
          $reader.Dispose()
          $obj = $json | ConvertFrom-Json
          foreach ($i in $mutedTracks) {
            if ($i -ge 0 -and $i -lt $obj.tracks.Count) {
              $obj.tracks[$i].soloMuteState.mute = $true
            }
          }
          $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Depth 30))
        } else {
          $ms = New-Object IO.MemoryStream
          $in2 = $entry.Open()
          $in2.CopyTo($ms)
          $in2.Dispose()
          $bytes = $ms.ToArray()
          $ms.Dispose()
        }
        $os.Write($bytes, 0, $bytes.Length)
        $os.Dispose()
      }
    } finally {
      $outZip.Dispose()
      $fs.Dispose()
    }
  } finally {
    $src.Dispose()
  }
  return $dest
}

function Convert-Mscz([byte[]]$bytes, [string]$wantExt, [int[]]$mutedTracks = @(), [string]$ext = 'mscz') {
  # Render one .mscz -> audio (wantExt) + MIDI, zip them, return zip bytes.
  # Both exports come from MuseScore's own playback engine, so the audio and the
  # MIDI tempo map agree with each other (that is what keeps visuals in sync).
  if (-not $msExe) { throw 'MuseScore CLI not found' }
  $id = [guid]::NewGuid().ToString('N')
  $tmpDir = [IO.Path]::GetTempPath()
  $in = Join-Path $tmpDir "pf_$id.$ext"
  $midiOut = Join-Path $tmpDir "pf_$id.mid"
  $zipOut = Join-Path $tmpDir "pf_$id.zip"
  $audioOut = $null

  try {
    [IO.File]::WriteAllBytes($in, $bytes)

    # If some tracks are muted, patch the mixer state first (notes stay untouched)
    if ($mutedTracks.Count -gt 0) {
      $muted = Patch-AudioSettings $in $mutedTracks
      Remove-Item -LiteralPath $in -Force -ErrorAction SilentlyContinue
      $in = $muted
    }

    $midiOk = Invoke-MuseScore -in $in -out $midiOut
    if (-not $midiOk -or -not (Test-Path -LiteralPath $midiOut)) {
      $sz = 0
      if (Test-Path -LiteralPath $in) { $sz = (Get-Item -LiteralPath $in).Length }
      throw ("MIDI export failed (in=$in size=$sz expected=$($bytes.Length))")
    }

    foreach ($ext in @('mp3', 'ogg', 'wav')) {
      $candidate = Join-Path $tmpDir "pf_$id.$ext"
      if (Invoke-MuseScore -in $in -out $candidate) {
        if ((Test-Path -LiteralPath $candidate) -and (Get-Item $candidate).Length -gt 1024) {
          $audioOut = $candidate
          $wantExt = $ext
          break
        }
      }
    }
    if (-not $audioOut) { throw 'audio export failed (mp3/ogg/wav all failed)' }

    Add-Type -AssemblyName System.IO.Compression
    $fs = [IO.File]::Open($zipOut, 'Create')
    $zip = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
    foreach ($pair in @(@('score.mid', $midiOut), @("score.$wantExt", $audioOut))) {
      $entry = $zip.CreateEntry($pair[0], [IO.Compression.CompressionLevel]::NoCompression)
      $es = $entry.Open()
      $b = [IO.File]::ReadAllBytes($pair[1])
      $es.Write($b, 0, $b.Length)
      $es.Dispose()
    }
    $zip.Dispose()
    $fs.Dispose()
    return [IO.File]::ReadAllBytes($zipOut)
  } finally {
    foreach ($p in @($in, $midiOut, $zipOut)) {
      Remove-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue
    }
    Get-ChildItem -Path $tmpDir -Filter "pf_$id.*" -ErrorAction SilentlyContinue |
      Remove-Item -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-MuseScore([string]$in, [string]$out) {
  try {
    $p = Start-Process -FilePath $msExe -ArgumentList @('-o', "`"$out`"", "`"$in`"") -PassThru -WindowStyle Hidden
    if (-not $p.WaitForExit(120000)) {
      try { $p.Kill() } catch {}
      return $false
    }
    return $true
  } catch {
    return $false
  }
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $port)
try {
  $listener.Start()
} catch {
  # Already running (or port busy): just open the page and quit.
  if (-not $NoBrowser) { Start-Process $url }
  exit
}

Write-Host ""
Write-Host "  Piano Falls   $url" -ForegroundColor Cyan
Write-Host "  root         $root"
Write-Host "  MuseScore    $(if ($msExe) { $msExe } else { 'not found (mscz fallback disabled)' })"
Write-Host "  close this window to stop."
Write-Host ""

if (-not $NoBrowser) { Start-Process $url }

while ($true) {
  $client = $listener.AcceptTcpClient()
  try {
    $client.ReceiveTimeout = 5000
    $client.SendTimeout = 15000
    $client.NoDelay = $true
    $stream = $client.GetStream()

    $req = Read-Request $stream
    if (-not $req.Ok) { continue }

    $method = $req.Method
    $rawPath = $req.Path
    $rawQuery = ''
    $q = $rawPath.IndexOf('?')
    if ($q -ge 0) {
      $rawQuery = $rawPath.Substring($q + 1)
      $rawPath = $rawPath.Substring(0, $q)
    }

    # ---- version (for the "new build, please refresh" hint) ----
    if ($rawPath -eq '/version') {
      try {
        $files = @(Get-ChildItem -LiteralPath $root -Filter 'index.html' -File -ErrorAction SilentlyContinue)
        $srcDir = Join-Path $root 'src'
        if (Test-Path -LiteralPath $srcDir) {
          $files += @(Get-ChildItem -LiteralPath $srcDir -Filter '*.js' -File -ErrorAction SilentlyContinue)
        }
        $max = 0
        foreach ($f in $files) { if ($f.LastWriteTimeUtc.Ticks -gt $max) { $max = $f.LastWriteTimeUtc.Ticks } }
        Send-Text $stream 200 ("{""build"":""$max""}")
      } catch {
        Send-Text $stream 200 '{"build":"0"}'
      }
      continue
    }

    # ---- health ----
    if ($rawPath -eq '/health') {
      $json = @{ ok = $true; musescore = $(if ($msExe) { $msExe } else { $null }); root = $root } | ConvertTo-Json -Compress
      Send-Bytes $stream 200 'application/json; charset=utf-8' ([System.Text.Encoding]::UTF8.GetBytes($json))
      continue
    }

    # ---- mscz -> midi via local MuseScore ----
    if ($rawPath -eq '/convert') {
      if ($method -ne 'POST') { Send-Text $stream 405 'POST only'; continue }
      if (-not $msExe) { Send-Text $stream 503 'MuseScore 4 CLI not found on this machine'; continue }
      try {
        $midi = Convert-MsczToMidi $req.Body
        Send-Bytes $stream 200 'audio/midi' $midi
      } catch {
        Send-Text $stream 500 ("convert failed: " + $_.Exception.Message)
      }
      continue
    }

    if ($rawPath -eq '/render') {
      if ($method -ne 'POST') { Send-Text $stream 405 'POST only'; continue }
      if (-not $msExe) { Send-Text $stream 503 'MuseScore 4 CLI not found on this machine'; continue }
      try {
        $muteArg = @()
        if ($rawQuery -match 'mute=([0-9,]*)') {
          $muteArg = $matches[1].Split(',') | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ }
        }
        $ext = 'mscz'
        if ($rawQuery -match 'ext=(mscx|mscz)') { $ext = $matches[1] }
        $zip = Convert-Mscz $req.Body 'mp3' $muteArg $ext
        Send-Bytes $stream 200 'application/zip' $zip
      } catch {
        Send-Text $stream 500 ("render failed: " + $_.Exception.Message)
      }
      continue
    }

    if ($method -ne 'GET' -and $method -ne 'HEAD') { Send-Text $stream 405 'Only GET/HEAD'; continue }

    if ($rawPath -eq '/' -or $rawPath -eq '') { $rawPath = '/index.html' }
    $rel = [uri]::UnescapeDataString($rawPath.TrimStart('/')) -replace '/', '\'
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))

    if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      Send-Text $stream 403 'Forbidden'
      continue
    }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      Send-Text $stream 404 "Not Found: $rawPath"
      continue
    }

    $bytes = [System.IO.File]::ReadAllBytes($full)
    $ext = [System.IO.Path]::GetExtension($full).ToLower()
    $ct = $types[$ext]
    if (-not $ct) { $ct = 'application/octet-stream' }
    if ($method -eq 'HEAD') { Send-Bytes $stream 200 $ct (New-Object byte[] 0) }
    else { Send-Bytes $stream 200 $ct $bytes }
  } catch {
    # one bad request must not kill the server (browser aborts are common)
  } finally {
    try { $client.Close() } catch {}
  }
}
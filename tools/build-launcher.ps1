# Build the double-click launcher exe for the Go game.
# Requires only the .NET Framework C# compiler that ships with Windows.
#   powershell -ExecutionPolicy Bypass -File tools/build-launcher.ps1 [-Force]

param([switch]$Force)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$assets = Join-Path $root 'assets'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) { $csc = 'C:\Windows\Microsoft.NET\Framework\v4.0.30319\csc.exe' }
if (-not (Test-Path $csc)) { throw 'csc.exe (.NET Framework compiler) not found' }

New-Item -ItemType Directory -Force $assets | Out-Null
Add-Type -AssemblyName System.Drawing

# ---------------------------------------------------------------- 1. icon
$ico = Join-Path $assets 'app.ico'
if ($Force -or -not (Test-Path $ico)) {
    $size = 256
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

    $rect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    $bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 228, 186, 106),
        [System.Drawing.Color]::FromArgb(255, 197, 150, 68),
        45)
    $g.FillRectangle($bg, $rect)

    $grid = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(190, 62, 46, 20)), 5
    $m = 52
    $step = ($size - 2 * $m) / 2
    for ($i = 0; $i -lt 3; $i++) {
        $p = $m + $i * $step
        $g.DrawLine($grid, $p, $m, $p, ($size - $m))
        $g.DrawLine($grid, $m, $p, ($size - $m), $p)
    }

    function Draw-Stone($cx, $cy, $r, $isBlack) {
        $path = New-Object System.Drawing.Drawing2D.GraphicsPath
        $path.AddEllipse(($cx - $r), ($cy - $r), (2 * $r), (2 * $r))
        if ($isBlack) {
            $b = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
            $b.CenterColor = [System.Drawing.Color]::FromArgb(255, 92, 92, 92)
            $b.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 5, 5, 5))
        }
        else {
            $b = New-Object System.Drawing.Drawing2D.PathGradientBrush $path
            $b.CenterColor = [System.Drawing.Color]::White
            $b.SurroundColors = @([System.Drawing.Color]::FromArgb(255, 200, 200, 200))
        }
        $g.FillPath($b, $path)
        $border = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(120, 0, 0, 0)), 2
        $g.DrawPath($border, $path)
    }

    Draw-Stone $m $m 40 $true
    Draw-Stone ($size - $m) ($size - $m) 40 $false

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $png = $ms.ToArray()

    # PNG payload wrapped in an ICO container (Vista+)
    $icoStream = New-Object System.IO.MemoryStream
    $bw = New-Object System.IO.BinaryWriter $icoStream
    $bw.Write([UInt16]0)      # reserved
    $bw.Write([UInt16]1)      # type = icon
    $bw.Write([UInt16]1)      # image count
    $bw.Write([Byte]0)        # width 256
    $bw.Write([Byte]0)        # height 256
    $bw.Write([Byte]0)        # palette
    $bw.Write([Byte]0)        # reserved
    $bw.Write([UInt16]1)      # planes
    $bw.Write([UInt16]32)     # bpp
    $bw.Write([UInt32]$png.Length)
    $bw.Write([UInt32]22)     # offset
    $bw.Write($png)
    $bw.Flush()
    [System.IO.File]::WriteAllBytes($ico, $icoStream.ToArray())
    $bmp.Dispose(); $g.Dispose()
    Write-Host "icon: $ico ($([math]::Round((Get-Item $ico).Length/1KB)) KB)"
}

# ---------------------------------------------------------------- 2. exe
$cs = Join-Path $PSScriptRoot 'launcher\launcher.cs'
$name = 'Komi.exe'
$out = Join-Path $root $name

Write-Host "compiling -> $out"
& $csc /nologo /target:winexe /codepage:65001 /optimize+ `
    /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
    /win32icon:$ico /out:$out $cs
if ($LASTEXITCODE -ne 0) { throw "csc failed with exit code $LASTEXITCODE" }

$item = Get-Item $out
Write-Host ("built: {0} ({1} KB)" -f $item.FullName, [math]::Round($item.Length / 1KB))

Add-Type -AssemblyName System.Drawing

function New-Icon {
  param(
    [string]$Path,
    [int]$Size,
    [string]$Bg,
    [string]$Fg,
    [string]$Text,
    [float]$FontScale = 0.38
  )
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $bgColor = [System.Drawing.ColorTranslator]::FromHtml($Bg)
  $fgColor = [System.Drawing.ColorTranslator]::FromHtml($Fg)

  # rounded rect background
  $radius = [Math]::Max(4, [int]($Size * 0.18))
  $rect = New-Object System.Drawing.Rectangle(1, 1, ($Size - 2), ($Size - 2))
  $path2 = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path2.AddArc($rect.X, $rect.Y, $radius, $radius, 180, 90)
  $path2.AddArc(($rect.X + $rect.Width - $radius), $rect.Y, $radius, $radius, 270, 90)
  $path2.AddArc(($rect.X + $rect.Width - $radius), ($rect.Y + $rect.Height - $radius), $radius, $radius, 0, 90)
  $path2.AddArc($rect.X, ($rect.Y + $rect.Height - $radius), $radius, $radius, 90, 90)
  $path2.CloseFigure()
  $brush = New-Object System.Drawing.SolidBrush($bgColor)
  $g.FillPath($brush, $path2)

  if ($Text) {
    $fontSize = [float]($Size * $FontScale)
    $font = New-Object System.Drawing.Font("Segoe UI", $fontSize, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $fgBrush = New-Object System.Drawing.SolidBrush($fgColor)
    $layout = New-Object System.Drawing.RectangleF(0, 0, $Size, ($Size * 1.02))
    $g.DrawString($Text, $font, $fgBrush, $layout, $fmt)
  }

  $dir = Split-Path $Path -Parent
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
  Write-Output "wrote $Path"
}

$sd = "apps\streamdeck\com.callout-relay.sdPlugin\imgs"

# plugin + category icons (20x20)
New-Icon -Path "$sd\plugin\icon.png" -Size 20 -Bg "#131313" -Fg "#efeae0" -Text "R" -FontScale 0.6
New-Icon -Path "$sd\category\icon.png" -Size 20 -Bg "#131313" -Fg "#efeae0" -Text "R" -FontScale 0.6

# action icon (72x72)
New-Icon -Path "$sd\actions\toggle\icon.png" -Size 72 -Bg "#131313" -Fg "#efeae0" -Text "CR" -FontScale 0.4

# key states: off (dark) / on (green)
New-Icon -Path "$sd\actions\toggle\key-off.png" -Size 144 -Bg "#131313" -Fg "#8a877f" -Text "RELAY" -FontScale 0.2
New-Icon -Path "$sd\actions\toggle\key-off@2x.png" -Size 288 -Bg "#131313" -Fg "#8a877f" -Text "RELAY" -FontScale 0.2
New-Icon -Path "$sd\actions\toggle\key-on.png" -Size 144 -Bg "#e0a43a" -Fg "#131313" -Text "LIVE" -FontScale 0.2
New-Icon -Path "$sd\actions\toggle\key-on@2x.png" -Size 288 -Bg "#e0a43a" -Fg "#131313" -Text "LIVE" -FontScale 0.2

# standalone tray icons (16x16) + app icon (256x256)
New-Icon -Path "apps\standalone\assets\tray.png" -Size 16 -Bg "#131313" -Fg "#efeae0" -Text "R" -FontScale 0.62
New-Icon -Path "apps\standalone\assets\tray-live.png" -Size 16 -Bg "#e0a43a" -Fg "#131313" -Text "R" -FontScale 0.62
New-Icon -Path "apps\standalone\assets\icon.png" -Size 256 -Bg "#131313" -Fg "#efeae0" -Text "R" -FontScale 0.6

$src = 'C:\Users\Lenovo\Desktop\快捷\图片\logo\png\logo.png'
$b = [System.IO.File]::ReadAllBytes($src)
Add-Type -AssemblyName System.Drawing
$ms = New-Object System.IO.MemoryStream(, $b)
$img = [System.Drawing.Image]::FromStream($ms)
Write-Host ('SIZE:' + $img.Width + 'x' + $img.Height)
$img.Dispose()

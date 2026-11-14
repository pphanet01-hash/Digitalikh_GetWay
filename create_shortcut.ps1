$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$DesktopPath = [Environment]::GetFolderPath("Desktop")
$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut((Join-Path $DesktopPath "DigitalikhGetWay.lnk"))
$Shortcut.TargetPath = "$env:SystemRoot\System32\wscript.exe"
$Shortcut.Arguments = """$(Join-Path $AppDir 'launcher.vbs')"""
$Shortcut.WorkingDirectory = $AppDir
$Shortcut.IconLocation = Join-Path $AppDir "assets\icon.ico"
$Shortcut.WindowStyle = 1
$Shortcut.Description = "DIGITALIKH GETWAY - Neural AI Gateway"
$Shortcut.Save()
Write-Host "Desktop shortcut created successfully!"

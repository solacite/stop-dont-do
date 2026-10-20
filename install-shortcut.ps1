# adds "Slack (stop dont do)" to the start menu and desktop
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs = Join-Path $here "start-slack.vbs"
$pkg = Get-AppxPackage com.tinyspeck.slackdesktop
$icon = if ($pkg) { Join-Path $pkg.InstallLocation "app\Slack.exe" } else { Join-Path $env:LOCALAPPDATA "slack\slack.exe" }

$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop"))) {
  $lnk = $shell.CreateShortcut((Join-Path $dir "Slack (stop dont do).lnk"))
  $lnk.TargetPath = "$env:WINDIR\System32\wscript.exe"
  $lnk.Arguments = "`"$vbs`""
  $lnk.WorkingDirectory = $here
  if (Test-Path $icon) { $lnk.IconLocation = "$icon,0" }
  $lnk.Save()
  Write-Host "made $($lnk.FullName)"
}

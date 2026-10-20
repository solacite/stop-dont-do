# talks to windows' media controls (the same ones media keys use) for the dash bar.
# reads one command per line on stdin: state | toggle | next | prev | seek <seconds>
# and answers each with one line of json on stdout.
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]
function Await($op, [Type]$t) {
  $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
[Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
$mgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

# whatever is playing on this computer: something that's playing right now first, then
# what windows considers current, then spotify. slack itself (the dash video) is skipped.
function Get-Session {
  $all = @($mgr.GetSessions() | Where-Object { $_.SourceAppUserModelId -notmatch 'slack' })
  if (-not $all.Count) { return $null }
  $playing = $all | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' } | Select-Object -First 1
  if ($playing) { return $playing }
  $current = $mgr.GetCurrentSession()
  if ($current -and $current.SourceAppUserModelId -notmatch 'slack') { return $current }
  $spotify = $all | Where-Object { $_.SourceAppUserModelId -match 'spotify' } | Select-Object -First 1
  if ($spotify) { return $spotify }
  $all[0]
}

function Get-State {
  $s = Get-Session
  if (-not $s) { return @{ ok = $false; reason = 'nothing is playing on this computer' } }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $tl = $s.GetTimelineProperties()
  $playing = $s.GetPlaybackInfo().PlaybackStatus -eq 'Playing'
  # spotify only reports its position now and then, so move it forward by the time since
  $pos = $tl.Position.TotalSeconds
  if ($playing) { $pos += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds }
  # "Spotify.exe", "Chrome", "Microsoft.ZuneMusic_8wekyb3d8bbwe!Microsoft.ZuneMusic" -> a short app name
  $app = ($s.SourceAppUserModelId -split '[!\\]')[-1] -replace '\.exe$', ''
  @{ ok = $true; app = $app; title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle; time = [math]::Min($pos, $tl.EndTime.TotalSeconds); dur = $tl.EndTime.TotalSeconds; playing = $playing }
}

[Console]::Out.Flush()
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $parts = $line.Trim() -split '\s+', 2
  $out = $null
  try {
    $s = Get-Session
    switch ($parts[0]) {
      'toggle' { if ($s) { Await ($s.TryTogglePlayPauseAsync()) ([bool]) | Out-Null } }
      'next' { if ($s) { Await ($s.TrySkipNextAsync()) ([bool]) | Out-Null } }
      'prev' { if ($s) { Await ($s.TrySkipPreviousAsync()) ([bool]) | Out-Null } }
      'seek' { if ($s) { Await ($s.TryChangePlaybackPositionAsync([long]([double]$parts[1] * 10000000))) ([bool]) | Out-Null } }
    }
    $out = Get-State
  } catch {
    $out = @{ ok = $false; reason = $_.Exception.Message }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

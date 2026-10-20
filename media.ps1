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

# spotify's session if there is one
function Get-Session {
  $all = @($mgr.GetSessions())
  $s = $all | Where-Object { $_.SourceAppUserModelId -match 'spotify' } | Select-Object -First 1
  if (-not $s) { return $null }
  $s
}

function Get-State {
  $s = Get-Session
  if (-not $s) { return @{ ok = $false; reason = 'spotify is not playing anything' } }
  $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
  $tl = $s.GetTimelineProperties()
  $playing = $s.GetPlaybackInfo().PlaybackStatus -eq 'Playing'
  # spotify only reports its position now and then, so move it forward by the time since
  $pos = $tl.Position.TotalSeconds
  if ($playing) { $pos += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds }
  @{ ok = $true; title = $p.Title; artist = $p.Artist; album = $p.AlbumTitle; time = [math]::Min($pos, $tl.EndTime.TotalSeconds); dur = $tl.EndTime.TotalSeconds; playing = $playing }
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

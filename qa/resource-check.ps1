param([int] $SampleCount = 4, [double] $BusyThresholdPercent = 5)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$session = Get-Content -LiteralPath (Join-Path $taskRoot '.artifacts/overhaul-20260906/processes.json') -Raw | ConvertFrom-Json
$processes = @(Get-CimInstance Win32_Process)
$ownedBrowser = $processes | Where-Object { $_.ProcessId -eq $session.browserPid }
if (-not $ownedBrowser -or $ownedBrowser.CommandLine -notlike "*$($session.profile)*") {
    throw 'Recorded QA browser identity could not be verified.'
}
$allowed = [System.Collections.Generic.HashSet[int]]::new()
[void] $allowed.Add([int] $session.browserPid)
do {
    $added = 0
    foreach ($process in $processes) {
        if ($allowed.Contains([int] $process.ParentProcessId) -and $allowed.Add([int] $process.ProcessId)) { $added++ }
    }
} while ($added -gt 0)
$gpuBefore = & nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu,clocks.current.graphics,power.draw,power.limit --format=csv,noheader,nounits
$samples = @(Get-Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 1 -MaxSamples $SampleCount -ErrorAction SilentlyContinue)
$validSamples = @($samples.CounterSamples | Where-Object { $_.Status -eq 0 })
$rows = foreach ($sample in $validSamples) {
    if ($sample.InstanceName -notmatch 'pid_(\d+).*engtype_([^_]+)$') { continue }
    $processIdValue = [int] $Matches[1]
    $engine = $Matches[2].ToLowerInvariant()
    if ($engine -notin @('3d', 'compute', 'computing', 'videodecode', 'videoprocessing')) { continue }
    [pscustomobject]@{ ProcessId = $processIdValue; Engine = $engine; Utilization = [double] $sample.CookedValue }
}
$summary = @(foreach ($group in ($rows | Group-Object ProcessId, Engine)) {
    $processIdValue = $group.Group[0].ProcessId
    $process = $processes | Where-Object { $_.ProcessId -eq $processIdValue } | Select-Object -First 1
    $peak = ($group.Group | Measure-Object Utilization -Maximum).Maximum
    if ($peak -lt 0.5) { continue }
    [pscustomobject]@{
        processId = $processIdValue; process = $process.Name; engine = $group.Group[0].Engine
        peakPercent = [math]::Round($peak, 2)
        meanPercent = [math]::Round(($group.Group | Measure-Object Utilization -Average).Average, 2)
        owned = $allowed.Contains($processIdValue)
    }
})
$busy = @($summary | Where-Object { -not $_.owned -and $_.peakPercent -ge $BusyThresholdPercent })
$gpuAfter = & nvidia-smi --query-gpu=name,driver_version,memory.total,memory.used,utilization.gpu,temperature.gpu,clocks.current.graphics,power.draw,power.limit --format=csv,noheader,nounits
[pscustomobject]@{
    date = [DateTime]::UtcNow.ToString('o'); sampleCount = $samples.Count; validCounterSamples = $validSamples.Count
    clean = ($validSamples.Count -gt 0 -and $busy.Count -eq 0); thresholdPercent = $BusyThresholdPercent
    busy = $busy; engines = @($summary | Sort-Object peakPercent -Descending)
    gpuCsvColumns = 'name, driver, totalMiB, usedMiB, utilizationPercent, temperatureC, graphicsMHz, powerW, limitW'
    gpuBefore = $gpuBefore; gpuAfter = $gpuAfter
} | ConvertTo-Json -Depth 6 -Compress

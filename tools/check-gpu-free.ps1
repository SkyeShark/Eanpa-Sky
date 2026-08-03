param(
    [double] $BusyThresholdPercent = 5.0,
    [int] $SampleCount = 4,
    [int[]] $AllowedProcessId = @()
)

$samples = Get-Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 1 -MaxSamples $SampleCount -ErrorAction SilentlyContinue
$rows = foreach ($sample in $samples.CounterSamples) {
    if ($sample.Status -ne 0 -or $sample.CookedValue -lt 0.5) { continue }
    if ($sample.InstanceName -notmatch 'pid_(\d+).*engtype_([^_]+)$') { continue }
    $engine = $Matches[2].ToLowerInvariant()
    if ($engine -notin @('3d', 'compute', 'computing', 'videodecode', 'videoprocessing')) { continue }
    [pscustomobject]@{
        ProcessId = [int] $Matches[1]
        Engine = $engine
        Utilization = [double] $sample.CookedValue
    }
}
if (-not $rows) {
    Write-Error '[GPU-GATE] No valid engine samples; refusing benchmark.'
    exit 3
}
$summary = foreach ($group in ($rows | Group-Object ProcessId, Engine)) {
    $pidValue = $group.Group[0].ProcessId
    $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
    [pscustomobject]@{
        ProcessId = $pidValue
        Process = if ($process) { $process.ProcessName } else { 'exited' }
        Engine = $group.Group[0].Engine
        PeakPercent = [math]::Round(($group.Group | Measure-Object Utilization -Maximum).Maximum, 1)
        AveragePercent = [math]::Round(($group.Group | Measure-Object Utilization -Average).Average, 1)
        Allowed = $AllowedProcessId -contains $pidValue
    }
}
$summary | Sort-Object PeakPercent -Descending | Format-Table -AutoSize
$busy = @($summary | Where-Object { -not $_.Allowed -and $_.PeakPercent -ge $BusyThresholdPercent })
if ($busy.Count) {
    Write-Host "[GPU-GATE] BUSY: $($busy.Count) external engines reached $BusyThresholdPercent%."
    exit 2
}
Write-Host '[GPU-GATE] FREE: clean window; one foreground Eanpa page may be measured.'
exit 0

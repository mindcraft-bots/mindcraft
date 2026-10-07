# ============================================================
# Echo-Nova - Mindcraft Live Progress Monitor
# ============================================================

$Root       = "C:\Users\kiero\mindcraft-furrywall-test"
$RunsDir    = Join-Path $Root "pc-runner\runs"
$RunnerLog  = Join-Path $RunsDir "runner.log"

$RefreshSeconds = 2

function Get-CurrentRun {

    if (-not (Test-Path $RunnerLog)) {
        return $null
    }

    $lines = Get-Content $RunnerLog -Tail 250 -ErrorAction SilentlyContinue

    $startLine = $lines |
        Where-Object { $_ -match 'starting run (\d+) -> (.+run-\d{8}-\d{6}\.log)' } |
        Select-Object -Last 1

    if (-not $startLine) {
        return $null
    }

    if ($startLine -match 'starting run (\d+) -> (.+run-\d{8}-\d{6}\.log)') {

        $runNumber = $matches[1]
        $relative  = $matches[2].Trim()

        $filename = Split-Path $relative -Leaf
        $fullPath = Join-Path $RunsDir $filename

        return [PSCustomObject]@{
            Number = $runNumber
            File   = $fullPath
            Name   = $filename
        }
    }
}

function Get-RunStartTime {
    param($FileName)

    if ($FileName -match 'run-(\d{8})-(\d{6})\.log') {

        $stamp = "$($matches[1])-$($matches[2])"

        try {
            return [datetime]::ParseExact(
                $stamp,
                "yyyyMMdd-HHmmss",
                [Globalization.CultureInfo]::InvariantCulture
            )
        }
        catch {
            return $null
        }
    }

    return $null
}

function Format-Elapsed {
    param([TimeSpan]$Elapsed)

    if ($Elapsed.TotalHours -ge 1) {
        return "{0:00}:{1:00}:{2:00}" -f `
            [int]$Elapsed.TotalHours,
            $Elapsed.Minutes,
            $Elapsed.Seconds
    }

    return "{0:00}:{1:00}" -f `
        [int]$Elapsed.TotalMinutes,
        $Elapsed.Seconds
}

function Get-LatestStatus {
    param($Lines)

    $status = $Lines |
        Where-Object { $_ -match '^\[status\]' } |
        Select-Object -Last 1

    if (-not $status) {
        return $null
    }

    $result = [ordered]@{
        Dimension = "?"
        Position  = "?"
        HP        = "?"
        Food      = "?"
        Action    = "?"
        Path      = "?"
        Digging   = "-"
    }

    if ($status -match '^\[status\]\s+(\S+)') {
        $result.Dimension = $matches[1]
    }

    if ($status -match '\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)') {
        $result.Position = "$($matches[1]), $($matches[2]), $($matches[3])"
    }

    if ($status -match 'hp=(\d+)') {
        $result.HP = $matches[1]
    }

    if ($status -match 'food=(\d+)') {
        $result.Food = $matches[1]
    }

    if ($status -match 'action=([^\s]+)') {
        $result.Action = $matches[1]
    }

    if ($status -match 'path=([^\s]+)') {
        $result.Path = $matches[1]
    }

    if ($status -match 'dig=([^\s]+)') {
        $result.Digging = $matches[1]
    }

    return [PSCustomObject]$result
}

function Get-Milestones {
    param($RunLines)

    $milestones = [ordered]@{
        "Stone pickaxe" = "-"
        "Iron pickaxe"  = "-"
        "Portal kit"    = "-"
        "Nether"        = "-"
        "Blaze rods"    = "-"
        "Ender pearls"  = "-"
        "Stronghold"    = "-"
        "The End"       = "-"
        "Dragon"        = "-"
    }

    foreach ($line in $RunLines) {

        if ($line -match 'stone pickaxe.*?(\d+:\d+)') {
            $milestones["Stone pickaxe"] = $matches[1]
        }

        if ($line -match 'iron pickaxe.*?(\d+:\d+)') {
            $milestones["Iron pickaxe"] = $matches[1]
        }

        if ($line -match 'portal kit.*?(\d+:\d+)') {
            $milestones["Portal kit"] = $matches[1]
        }

        if (
            $line -match '(entered|entering|reached).*nether' -or
            $line -match 'dimension.*nether'
        ) {
            if ($milestones["Nether"] -eq "-") {
                $milestones["Nether"] = "YES"
            }
        }

        if ($line -match 'blaze.*rod') {
            $milestones["Blaze rods"] = "YES"
        }

        if ($line -match 'ender.*pearl') {
            $milestones["Ender pearls"] = "YES"
        }

        if ($line -match 'stronghold') {
            $milestones["Stronghold"] = "YES"
        }

        if (
            $line -match 'the_end' -or
            $line -match 'dimension.*end'
        ) {
            $milestones["The End"] = "YES"
        }

        if (
            $line -match 'ender dragon.*(killed|defeated|dead)' -or
            $line -match 'beat.*game'
        ) {
            $milestones["Dragon"] = "DONE"
        }
    }

    return $milestones
}

while ($true) {

    $run = Get-CurrentRun

    Clear-Host

    Write-Host "============================================================" -ForegroundColor DarkCyan
    Write-Host "         ANDY - MINDCRAFT LIVE SPEEDRUN MONITOR" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor DarkCyan
    Write-Host ""

    if (-not $run) {

        Write-Host "No active run found." -ForegroundColor Yellow
        Write-Host ""
        Write-Host "Waiting for runner.log..." -ForegroundColor DarkGray

        Start-Sleep $RefreshSeconds
        continue
    }

    if (-not (Test-Path $run.File)) {

        Write-Host "Run $($run.Number) detected but log isn't ready yet." `
            -ForegroundColor Yellow

        Start-Sleep $RefreshSeconds
        continue
    }

    $runLines = Get-Content $run.File -Tail 1200 -ErrorAction SilentlyContinue

    $status     = Get-LatestStatus $runLines
    $milestones = Get-Milestones $runLines
    $start      = Get-RunStartTime $run.Name

    if ($start) {
        $elapsed = Format-Elapsed ((Get-Date) - $start)
    }
    else {
        $elapsed = "?"
    }

    Write-Host "RUN:        $($run.Number)" -ForegroundColor White
    Write-Host "ELAPSED:    $elapsed" -ForegroundColor Yellow
    Write-Host "LOG:        $($run.Name)" -ForegroundColor DarkGray

    Write-Host ""
    Write-Host "---------------- CURRENT STATUS ----------------" `
        -ForegroundColor DarkCyan

    if ($status) {

        $dimensionColour = "White"

        if ($status.Dimension -match "nether") {
            $dimensionColour = "Red"
        }
        elseif ($status.Dimension -match "end") {
            $dimensionColour = "Magenta"
        }

        Write-Host "Dimension:  " -NoNewline
        Write-Host $status.Dimension -ForegroundColor $dimensionColour

        Write-Host "Position:   $($status.Position)"
        Write-Host "Health:     $($status.HP) / 20"
        Write-Host "Food:       $($status.Food) / 20"
        Write-Host "Action:     $($status.Action)" -ForegroundColor Cyan
        Write-Host "Path:       $($status.Path)"
        Write-Host "Digging:    $($status.Digging)"
    }
    else {
        Write-Host "Waiting for first status update..." -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "---------------- MILESTONES --------------------" `
        -ForegroundColor DarkCyan

    foreach ($entry in $milestones.GetEnumerator()) {

        Write-Host ("{0,-16}" -f ($entry.Key + ":")) -NoNewline

        if ($entry.Value -eq "-") {
            Write-Host "waiting" -ForegroundColor DarkGray
        }
        elseif ($entry.Value -in @("YES", "DONE")) {
            Write-Host $entry.Value -ForegroundColor Green
        }
        else {
            Write-Host $entry.Value -ForegroundColor Green
        }
    }

    Write-Host ""
    Write-Host "---------------- RECENT EVENTS -----------------" `
        -ForegroundColor DarkCyan

    $events = $runLines |
        Where-Object {
            $_ -and
            $_ -notmatch 'Ollama Status: 404' -and
            $_ -notmatch 'Failed to send Ollama' -and
            $_ -notmatch '^\s+at ' -and
            $_ -notmatch 'node:internal' -and
            (
                $_ -match '\[status\]' -or
                $_ -match 'Speedrun split' -or
                $_ -match 'died' -or
                $_ -match 'slain' -or
                $_ -match 'shot by' -or
                $_ -match 'lava' -or
                $_ -match 'drowned' -or
                $_ -match 'portal' -or
                $_ -match 'nether' -or
                $_ -match 'blaze' -or
                $_ -match 'pearl' -or
                $_ -match 'stronghold' -or
                $_ -match 'dragon' -or
                $_ -match 'executing code' -or
                $_ -match 'parsed command'
            )
        } |
        Select-Object -Last 8

    if ($events) {
        foreach ($event in $events) {

            if ($event -match 'died|slain|shot by|lava|drowned') {
                Write-Host $event -ForegroundColor Red
            }
            elseif ($event -match 'portal|nether|blaze|pearl|stronghold|dragon|Speedrun split') {
                Write-Host $event -ForegroundColor Green
            }
            elseif ($event -match '\[status\]') {
                Write-Host $event -ForegroundColor DarkGray
            }
            else {
                Write-Host $event
            }
        }
    }
    else {
        Write-Host "No major events yet." -ForegroundColor DarkGray
    }

    Write-Host ""
    Write-Host "Refresh: ${RefreshSeconds}s | Ctrl+C to stop" `
        -ForegroundColor DarkGray

    Start-Sleep $RefreshSeconds
}
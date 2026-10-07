# Starts the PC speedrun runner (pc-runner/run-pc.sh) hidden and detached, so it keeps going with no terminal open and
# isn't stopped along with whatever started it. Its own output goes to pc-runner/runs/runner.log.
#   powershell -ExecutionPolicy Bypass -File pc-runner\start.ps1
$root = (Split-Path -Parent $PSScriptRoot) -replace '\\', '/'
$unix_root = '/' + $root.Substring(0, 1).ToLower() + $root.Substring(2)
$bash = 'C:\Program Files\Git\bin\bash.exe'
$cmd = "`"$bash`" -c `"cd '$unix_root' && pc-runner/run-pc.sh >> pc-runner/runs/runner.log 2>&1`""
$startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow = [uint16]0}
$res = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine = $cmd; CurrentDirectory = (Split-Path -Parent $PSScriptRoot); ProcessStartupInformation = $startup}
if ($res.ReturnValue -eq 0) { "PC runner started (process $($res.ProcessId)), log: pc-runner\runs\runner.log" } else { "Failed to start the PC runner: $($res.ReturnValue)" }

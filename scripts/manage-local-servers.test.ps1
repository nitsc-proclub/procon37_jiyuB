# End-to-end Windows regression checks. No application secrets or paid APIs are used.
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$sandbox = Join-Path $project ('logs/manager-tests/' + [guid]::NewGuid().ToString('N') + '/日本語 project')
$utf8Bom = [Text.UTF8Encoding]::new($true)
New-Item -ItemType Directory -Path (Join-Path $sandbox 'scripts'), (Join-Path $sandbox 'node_modules/vite/bin'), (Join-Path $sandbox 'node_modules/.bin'), (Join-Path $sandbox '超えかき歌_サーバー管理セット') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'manage-local-servers.ps1') -Destination (Join-Path $sandbox 'scripts/manage-local-servers.ps1')
foreach ($name in @('cho_ekakiuta_manager.ps1', '超えかき歌！_管理.bat')) { Copy-Item -LiteralPath (Join-Path $project ('超えかき歌_サーバー管理セット/' + $name)) -Destination (Join-Path $sandbox ('超えかき歌_サーバー管理セット/' + $name)) }
Copy-Item -LiteralPath (Join-Path $project 'manage-local.cmd') -Destination (Join-Path $sandbox 'manage-local.cmd')
$fixture = @'
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer((_req, res) => res.end('manager test')).listen(port, '0.0.0.0');
'@
[IO.File]::WriteAllText((Join-Path $sandbox 'node_modules/vite/bin/vite.js'), $fixture)
[IO.File]::WriteAllText((Join-Path $sandbox 'foreign.cjs'), $fixture)
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start(); $port = $listener.LocalEndpoint.Port; $listener.Stop()
$wrapper = Join-Path $sandbox '超えかき歌_サーバー管理セット/cho_ekakiuta_manager.ps1'
$foreign = $null
$npmStyle = $null
$checks = 0
$previousNoPause = $env:EKAKI_MANAGER_NO_PAUSE
$env:EKAKI_MANAGER_NO_PAUSE = '1'

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
    $script:checks++
    Write-Host "PASS: $Message"
}

function Read-Capture([string]$Path) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    $reader = [IO.StreamReader]::new($stream)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Run([string]$Action, [string]$InputText = '', [string]$Route = 'Wrapper') {
    $executable = 'powershell.exe'
    $arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $wrapper + '" -Action ' + $Action + ' -NormalPort ' + $port + ' -NoBrowser'
    if ($Route -eq 'Batch') {
        $executable = $env:ComSpec
        $arguments = '/d /c ""' + (Join-Path $sandbox '超えかき歌_サーバー管理セット/超えかき歌！_管理.bat') + '" -Action ' + $Action + ' -NormalPort ' + $port + ' -NoBrowser"'
    } elseif ($Route -eq 'Root') {
        $executable = $env:ComSpec
        $arguments = '/d /c ""' + (Join-Path $sandbox 'manage-local.cmd') + '" -Action ' + $Action + ' -NormalPort ' + $port + ' -NoBrowser"'
    }
    # Background servers can inherit pipe handles on Windows; use files so their
    # lifetime cannot keep ReadToEndAsync pending after the launcher has exited.
    $capture = Join-Path $sandbox ([guid]::NewGuid().ToString('N'))
    [IO.File]::WriteAllText(($capture + '.input'), $InputText + "`r`n", $utf8Bom)
    $process = Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $env:TEMP -WindowStyle Hidden -RedirectStandardInput ($capture + '.input') -RedirectStandardOutput ($capture + '.out') -RedirectStandardError ($capture + '.err') -PassThru
    try {
        $null = $process.Handle # Cache the handle before exit so Windows PowerShell retains ExitCode.
        if (-not $process.WaitForExit(45000)) { $process.Kill(); throw "Timed out: $Route $Action" }
        return [PSCustomObject]@{ Code = $process.ExitCode; Output = (Read-Capture ($capture + '.out')) + (Read-Capture ($capture + '.err')) }
    } finally { $process.Dispose() }
}

function ListeningPid {
    $connection = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection) { return $connection.OwningProcess }
    return 0
}

try {
    $result = Run 'Status'
    Assert ($result.Code -eq 0 -and $result.Output -match 'Running\s*:\s*False') 'Status works from another working directory'
    Assert (-not (Test-Path -LiteralPath (Join-Path $sandbox 'logs'))) 'Status does not create runtime files'
    $result = Run 'Menu' '0'
    Assert ($result.Code -eq 0 -and $result.Output -match '\[1\]' -and $result.Output -notmatch '\[E\]') 'Menu opens and closes without ensemble controls'
    $result = Run 'Start' '' 'Batch'
    Assert ($result.Code -eq 0 -and (ListeningPid) -gt 0) ('Japanese batch starts a server: ' + $result.Output.Trim())
    $firstPid = ListeningPid
    $result = Run 'Start'
    Assert ($result.Code -eq 0 -and (ListeningPid) -eq $firstPid) 'Repeated Start does not create a duplicate server'
    $result = Run 'Restart'
    Assert ($result.Code -eq 0 -and (ListeningPid) -gt 0 -and (ListeningPid) -ne $firstPid) 'Restart replaces the managed server'
    $result = Run 'Stop' '' 'Root'
    Assert ($result.Code -eq 0 -and (ListeningPid) -eq 0) 'Root launcher stops the managed server'

    $npmEntry = Join-Path $sandbox 'node_modules/.bin/../vite/bin/vite.js'
    $npmStyle = Start-Process node.exe -ArgumentList @(('"' + $npmEntry + '"'), '--port', [string]$port) -WindowStyle Hidden -PassThru
    for ($i=0; $i -lt 20 -and (ListeningPid) -eq 0; $i++) { Start-Sleep -Milliseconds 100 }
    $result = Run 'Status'
    Assert ($result.Code -eq 0 -and $result.Output -match 'Owned\s*:\s*True') 'npm .bin/../vite entry is recognized after path normalization'
    $result = Run 'Stop'
    Assert ($result.Code -eq 0 -and (ListeningPid) -eq 0) 'npm-launched server can be stopped'

    $foreign = Start-Process node.exe -ArgumentList @(('"' + (Join-Path $sandbox 'foreign.cjs') + '"'), '--port', [string]$port) -WindowStyle Hidden -PassThru
    for ($i=0; $i -lt 20 -and (ListeningPid) -eq 0; $i++) { Start-Sleep -Milliseconds 100 }
    # Even a PID file pointing at the unrelated server must not authorize stopping it.
    $testPidFile = Join-Path $sandbox "logs/local-server/normal-$port.pid"
    Set-Content -LiteralPath $testPidFile -Value $foreign.Id
    foreach ($action in @('Start', 'Stop', 'Restart')) {
        $result = Run $action
        $foreign.Refresh()
        Assert ($result.Code -eq 1 -and -not $foreign.HasExited -and (ListeningPid) -eq $foreign.Id) "$action protects another program using the port"
    }
    $foreign.Kill(); [void]$foreign.WaitForExit(5000)

    $broken = Join-Path $sandbox 'node_modules/vite/bin/vite.js'
    [IO.File]::WriteAllText($broken, 'process.exit(23);')
    $result = Run 'Start'
    Assert ($result.Code -eq 1 -and -not (Test-Path -LiteralPath $testPidFile)) 'Startup failure returns 1 and removes its PID file'

    Remove-Item -LiteralPath (Join-Path $sandbox 'scripts/manage-local-servers.ps1')
    foreach ($route in @('Wrapper', 'Batch', 'Root')) {
        $result = Run 'Status' '' $route
        Assert ($result.Code -eq 1 -and $result.Output.Length -gt 0) "$route returns 1 when the manager is missing"
    }
    Write-Host "All $checks checks passed. Fixtures and logs: $sandbox"
} finally {
    foreach ($process in @($foreign, $npmStyle)) {
        if ($process) { $process.Refresh(); if (-not $process.HasExited) { $process.Kill(); [void]$process.WaitForExit(5000) }; $process.Dispose() }
    }
    # Clean up only this fixture's owned server, including after an assertion failure.
    if (Test-Path -LiteralPath (Join-Path $sandbox 'scripts/manage-local-servers.ps1')) { $cleanup = Run 'Stop' }
    $env:EKAKI_MANAGER_NO_PAUSE = $previousNoPause
}

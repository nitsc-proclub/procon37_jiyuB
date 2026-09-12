param(
    [ValidateSet('Normal', 'Ensemble')][string]$App = 'Normal',
    [ValidateSet('Menu', 'Start', 'Stop', 'Restart', 'Status', 'Build')][string]$Action = 'Menu',
    [switch]$NoBrowser,
    [string]$ProjectPath = (Split-Path $PSScriptRoot -Parent),
    [int]$NormalPort = 3000,
    [int]$EnsemblePort = 3001
)

# Shared by the desktop batch file and the exhibition launcher. No public deployment commands.
$ErrorActionPreference = 'Stop'
$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
$runtimeDirectory = Join-Path $ProjectPath '.exhibition-build/manager'
New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
$profiles = @{
    Normal = @{ Name = '通常版'; Port = $NormalPort; Entry = 'node_modules/vite/bin/vite.js'; Build = 'build'; Log = 'normal'; PidFile = (Join-Path $ProjectPath '.dev-server.pid') }
    Ensemble = @{ Name = '合奏展示版'; Port = $EnsemblePort; Entry = '.exhibition-build/server.mjs'; Build = 'build:exhibition'; Log = 'ensemble'; PidFile = (Join-Path $runtimeDirectory 'ensemble.pid') }
}
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $Host.UI.RawUI.WindowTitle = '超えかき歌 - サーバー管理' } catch {}

function Get-ServerState([string]$Target) {
    $profile = $profiles[$Target]
    $connection = Get-NetTCPConnection -State Listen -LocalPort $profile.Port -ErrorAction SilentlyContinue | Select-Object -First 1
    $process = if ($connection) { Get-CimInstance Win32_Process -Filter "ProcessId=$($connection.OwningProcess)" -ErrorAction SilentlyContinue }
    $entry = [IO.Path]::GetFullPath((Join-Path $ProjectPath $profile.Entry)).Replace('\', '/')
    $command = if ($process) { ([string]$process.CommandLine).Replace('\', '/') } else { '' }
    # A listening port alone is not permission to terminate an unrelated process.
    $owned = $process -and $command.IndexOf($entry, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if (-not $owned -and $process -and $Target -eq 'Ensemble' -and $command -match '(?:^|\s)\.?/?\.exhibition-build/server\.mjs(?:\s|$)') {
        $dataDirectory = if ($env:EXHIBITION_DATA_DIR) { $env:EXHIBITION_DATA_DIR } else { 'exhibition-data' }
        if (-not [IO.Path]::IsPathRooted($dataDirectory)) { $dataDirectory = Join-Path $ProjectPath $dataDirectory }
        $lock = Join-Path $dataDirectory 'server.lock'
        $owned = (Test-Path -LiteralPath $lock) -and [string](Get-Content -LiteralPath $lock -TotalCount 1) -eq [string]$process.ProcessId
    }
    [PSCustomObject]@{ App = $Target; Name = $profile.Name; Port = $profile.Port; Running = [bool]$connection; Owned = [bool]$owned; Pid = $(if ($process) { [int]$process.ProcessId } else { $null }); Url = "http://localhost:$($profile.Port)" }
}

function Invoke-Build([string]$Target) {
    Push-Location $ProjectPath
    try {
        & npm.cmd run $profiles[$Target].Build
        if ($LASTEXITCODE -ne 0) { throw "$($profiles[$Target].Name)のビルドに失敗しました。" }
    } finally { Pop-Location }
}

function Start-LocalServer([string]$Target) {
    $profile = $profiles[$Target]
    $state = Get-ServerState $Target
    if ($state.Running) {
        if (-not $state.Owned) { throw "ポート $($state.Port) は別のプロセスが使用しています (PID $($state.Pid))。" }
        Write-Host "$($state.Name)は起動済みです: $($state.Url)" -ForegroundColor Yellow
        if (-not $NoBrowser) { Start-Process $state.Url }
        return
    }
    if (-not (Test-Path -LiteralPath (Join-Path $ProjectPath 'node_modules'))) { throw '先に npm.cmd ci を実行してください。' }
    if ($Target -eq 'Ensemble') { Invoke-Build $Target }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $entry = Join-Path $ProjectPath $profile.Entry
    $arguments = @('"' + $entry + '"')
    if ($Target -eq 'Normal') { $arguments += @('--host', '0.0.0.0', '--port', [string]$profile.Port, '--strictPort') }
    $outLog = Join-Path $runtimeDirectory ($profile.Log + '.log')
    $errLog = Join-Path $runtimeDirectory ($profile.Log + '.error.log')
    $previousPort = $env:EXHIBITION_PORT
    try {
        if ($Target -eq 'Ensemble') { $env:EXHIBITION_PORT = [string]$profile.Port }
        $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $ProjectPath -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
    } finally { $env:EXHIBITION_PORT = $previousPort }
    Set-Content -LiteralPath $profile.PidFile -Value $process.Id -Encoding ascii
    $deadline = (Get-Date).AddSeconds(30)
    do {
        $process.Refresh()
        if ($process.HasExited) { throw "起動に失敗しました。ログ: $errLog" }
        $state = Get-ServerState $Target
        Write-Verbose "Waiting: running=$($state.Running) owned=$($state.Owned) pid=$($state.Pid) expected=$($process.Id)"
        if ($state.Running -and $state.Owned -and $state.Pid -eq $process.Id) {
            try {
                # Windows PowerShell may send localhost through the system proxy or try IPv6 first.
                $health = [Net.HttpWebRequest]::Create("http://127.0.0.1:$($state.Port)/")
                $health.Proxy = $null; $health.Timeout = 2000
                $page = $health.GetResponse()
                $healthy = [int]$page.StatusCode -eq 200
                $page.Close()
                if ($healthy) {
                    Write-Host "$($state.Name)を起動しました: $($state.Url)" -ForegroundColor Green
                    if (-not $NoBrowser) { Start-Process $state.Url }
                    return
                }
            } catch { Write-Verbose $_.Exception.Message }
        }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)
    # Only clean up the exact process created by this invocation.
    Stop-Process -Id $process.Id -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $profile.PidFile -Force -ErrorAction SilentlyContinue
    throw "起動を確認できませんでした。ログ: $errLog"
}

function Stop-LocalServer([string]$Target) {
    $profile = $profiles[$Target]
    $state = Get-ServerState $Target
    if (-not $state.Running) { Remove-Item -LiteralPath $profile.PidFile -Force -ErrorAction SilentlyContinue; Write-Host "$($state.Name)は停止しています。"; return }
    if (-not $state.Owned) { throw "ポート $($state.Port) の別プロセスは停止しません (PID $($state.Pid))。" }
    Stop-Process -Id $state.Pid -ErrorAction Stop
    $deadline = (Get-Date).AddSeconds(8)
    do {
        if (-not (Get-ServerState $Target).Running) {
            Remove-Item -LiteralPath $profile.PidFile -Force -ErrorAction SilentlyContinue
            Write-Host "$($state.Name)を停止しました。" -ForegroundColor Green
            return
        }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    throw "$($state.Name)の停止を確認できませんでした。"
}

function Invoke-ServerAction([string]$Target, [string]$Command) {
    switch ($Command) {
        'Start' { Start-LocalServer $Target }
        'Stop' { Stop-LocalServer $Target }
        'Restart' { Stop-LocalServer $Target; Start-LocalServer $Target }
        'Status' { Get-ServerState $Target }
        'Build' { Invoke-Build $Target }
    }
}

if ($Action -ne 'Menu') { Invoke-ServerAction $App $Action; return }
while ($true) {
    Clear-Host
    Write-Host "`n  超えかき歌！ サーバー管理`n" -ForegroundColor Cyan
    foreach ($target in @('Normal', 'Ensemble')) {
        $state = Get-ServerState $target
        $status = if (-not $state.Running) { '停止中' } elseif ($state.Owned) { '起動中' } else { '別プロセスが使用中' }
        Write-Host "  $($state.Name) [$status]  $($state.Url)"
    }
    Write-Host "`n  操作対象: $($profiles[$App].Name)" -ForegroundColor Yellow
    Write-Host '  [N] 通常版へ切替     [E] 合奏展示版へ切替'
    Write-Host '  [1] 起動  [2] 停止  [3] 再起動  [4] ブラウザー'
    Write-Host '  [5] ビルド  [6] ログ  [7] フォルダー  [9] 状態更新'
    if ($App -eq 'Ensemble') { Write-Host '  [S] みんなで演奏画面  [C] 演奏スタートボタン  [W] みんなの作品' }
    Write-Host '  [0] 管理画面を閉じる（サーバーは動作を続けます）'
    $choice = Read-Host "`n  選択"
    if ($choice -eq '0' -or $null -eq $choice) { break }
    try {
        switch ($choice.ToUpperInvariant()) {
            'N' { $App = 'Normal' }
            'E' { $App = 'Ensemble' }
            '1' { Invoke-ServerAction $App 'Start'; [void](Read-Host 'Enterで戻る') }
            '2' { Invoke-ServerAction $App 'Stop'; [void](Read-Host 'Enterで戻る') }
            '3' { Invoke-ServerAction $App 'Restart'; [void](Read-Host 'Enterで戻る') }
            '4' { Start-Process (Get-ServerState $App).Url }
            '5' { Invoke-Build $App; [void](Read-Host 'Enterで戻る') }
            '6' { Start-Process notepad.exe -ArgumentList ('"' + (Join-Path $runtimeDirectory ($profiles[$App].Log + '.log')) + '"'); Start-Process notepad.exe -ArgumentList ('"' + (Join-Path $runtimeDirectory ($profiles[$App].Log + '.error.log')) + '"') }
            '7' { Start-Process explorer.exe -ArgumentList ('"' + $ProjectPath + '"') }
            'S' { if ($App -eq 'Ensemble') { Start-Process ((Get-ServerState $App).Url + '/stage') } }
            'C' { if ($App -eq 'Ensemble') { Start-Process ((Get-ServerState $App).Url + '/control') } }
            'W' { if ($App -eq 'Ensemble') { Start-Process ((Get-ServerState $App).Url + '/admin') } }
        }
    } catch { Write-Host $_.Exception.Message -ForegroundColor Red; [void](Read-Host 'Enterで戻る') }
}

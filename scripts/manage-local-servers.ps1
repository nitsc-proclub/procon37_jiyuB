param(
    [ValidateSet('Menu', 'Start', 'Stop', 'Restart', 'Status', 'Build', 'Shortcuts')]
    [string]$Action = 'Menu',
    [switch]$NoBrowser,
    [string]$ProjectPath = (Split-Path $PSScriptRoot -Parent),
    [ValidateRange(1, 65535)][int]$NormalPort = 3000
)

# Windows PowerShell 5.1: save this file as UTF-8 with BOM.
$ErrorActionPreference = 'Stop'
$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
$entry = Join-Path $ProjectPath 'node_modules/vite/bin/vite.js'
$logDirectory = Join-Path $ProjectPath 'logs/local-server'
$logName = if ($NormalPort -eq 3000) { 'normal' } else { "normal-$NormalPort" }
$outLog = Join-Path $logDirectory ($logName + '.log')
$errLog = Join-Path $logDirectory ($logName + '.error.log')
$pidFile = if ($NormalPort -eq 3000) { Join-Path $ProjectPath '.dev-server.pid' } else { Join-Path $logDirectory ($logName + '.pid') }
$url = "http://localhost:$NormalPort"
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $Host.UI.RawUI.WindowTitle = '超えかき歌！ サーバー管理' } catch {}

function Test-ManagedProcess($Owner) {
    if (-not $Owner -or [IO.Path]::GetFileName([string]$Owner.ExecutablePath) -ine 'node.exe') { return $false }
    # The script argument must match exactly. Normalize npm's .bin/../vite path too.
    $match = [regex]::Match([string]$Owner.CommandLine, '^\s*(?:"[^"]*"|\S+)\s+(?:"(?<entry>[^"]+)"|(?<entry>\S+))(?:\s|$)')
    if (-not $match.Success) { return $false }
    $scriptPath = $match.Groups['entry'].Value
    if (-not [IO.Path]::IsPathRooted($scriptPath)) { return $false }
    try { return [IO.Path]::GetFullPath($scriptPath) -ieq [IO.Path]::GetFullPath($entry) } catch { return $false }
}

function Get-ServerState {
    $connections = @(Get-NetTCPConnection -State Listen -LocalPort $NormalPort -ErrorAction SilentlyContinue)
    $ownerIds = @($connections | Select-Object -ExpandProperty OwningProcess -Unique)
    $owned = $false
    $owner = $null
    if ($ownerIds.Count -eq 1) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($ownerIds[0])" -ErrorAction SilentlyContinue
        # PID files and port numbers alone never authorize stopping another process.
        $owned = Test-ManagedProcess $owner
    }
    [PSCustomObject]@{
        Running = $connections.Count -gt 0
        Owned = [bool]$owned
        Pid = $(if ($owner) { [int]$owner.ProcessId } else { $null })
        Port = $NormalPort
        Url = $url
    }
}

function Test-ServerResponse {
    $response = $null
    try {
        $request = [Net.HttpWebRequest]::Create("http://127.0.0.1:$NormalPort/")
        $request.Proxy = $null
        $request.Timeout = 2000
        $response = $request.GetResponse()
        return [int]$response.StatusCode -eq 200
    } catch { return $false } finally { if ($response) { $response.Close() } }
}

function Start-LocalServer {
    $state = Get-ServerState
    if ($state.Running) {
        if (-not $state.Owned) { throw "ポート $NormalPort は別のプロセスが使用しています。停止せずに終了しました。" }
        Write-Host "通常版は起動済みです: $url" -ForegroundColor Yellow
        if (-not $NoBrowser) { Start-Process $url }
        return
    }
    if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'Vite が見つかりません。プロジェクトフォルダーで npm.cmd ci を実行してください。' }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $serverProcess = $null
    try {
        $serverProcess = Start-Process -FilePath $node -ArgumentList @(('"' + $entry + '"'), '--host', '0.0.0.0', '--port', [string]$NormalPort, '--strictPort') -WorkingDirectory $ProjectPath -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
        Set-Content -LiteralPath $pidFile -Value $serverProcess.Id -Encoding ascii
        $deadline = (Get-Date).AddSeconds(30)
        do {
            $serverProcess.Refresh()
            if ($serverProcess.HasExited) { throw "起動に失敗しました。ログ: $errLog" }
            $state = Get-ServerState
            if ($state.Owned -and $state.Pid -eq $serverProcess.Id -and (Test-ServerResponse)) {
                Write-Host "通常版を起動しました: $url" -ForegroundColor Green
                if (-not $NoBrowser) { Start-Process $url }
                return
            }
            Start-Sleep -Milliseconds 250
        } while ((Get-Date) -lt $deadline)
        throw "30秒以内に起動を確認できませんでした。ログ: $errLog"
    } catch {
        # Kill only the process object created here, never an arbitrary PID from disk.
        if ($serverProcess) {
            $serverProcess.Refresh()
            if (-not $serverProcess.HasExited) { $serverProcess.Kill(); [void]$serverProcess.WaitForExit(5000) }
            Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

function Stop-LocalServer {
    $state = Get-ServerState
    if (-not $state.Running) {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        Write-Host '通常版は停止しています。'
        return
    }
    if (-not $state.Owned) { throw "ポート $NormalPort の別プロセスは停止しません。" }
    Stop-Process -Id $state.Pid -ErrorAction Stop
    $deadline = (Get-Date).AddSeconds(8)
    do {
        if (-not (Get-ServerState).Running) {
            Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
            Write-Host '通常版を停止しました。' -ForegroundColor Green
            return
        }
        Start-Sleep -Milliseconds 200
    } while ((Get-Date) -lt $deadline)
    throw '通常版の停止を確認できませんでした。'
}

function Invoke-ServerAction([string]$Command) {
    # Serialize double-clicks and actions from multiple manager windows.
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $key = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($ProjectPath.ToLowerInvariant()))).Replace('-', '') } finally { $sha.Dispose() }
    $mutex = [Threading.Mutex]::new($false, ('Local\EkakiNormalServer-' + $key))
    $locked = $false
    try {
        try { $locked = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $locked = $true }
        if (-not $locked) { throw 'ほかの管理画面で処理中です。処理が終わってからもう一度操作してください。' }
        switch ($Command) {
            'Start' { Start-LocalServer }
            'Stop' { Stop-LocalServer }
            'Restart' { Stop-LocalServer; Start-LocalServer }
            'Status' { Get-ServerState }
            'Build' {
                Push-Location $ProjectPath
                try {
                    & npm.cmd run build
                    if ($LASTEXITCODE -ne 0) { throw '通常版のビルドに失敗しました。' }
                } finally { Pop-Location }
            }
            'Shortcuts' { & (Join-Path $PSScriptRoot 'setup-local-shortcuts.ps1') -ProjectPath $ProjectPath }
        }
    } finally { if ($locked) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}

if ($Action -ne 'Menu') { Invoke-ServerAction $Action; return }
while ($true) {
    Clear-Host
    $state = Get-ServerState
    $status = if (-not $state.Running) { '停止中' } elseif ($state.Owned) { '起動中' } else { '別プロセスがポートを使用中' }
    Write-Host "`n  超えかき歌！ サーバー管理（通常版）`n" -ForegroundColor Cyan
    Write-Host "  状態: $status   $url" -ForegroundColor Yellow
    Write-Host "`n  [1] 起動して開く       [2] 停止       [3] 再起動"
    Write-Host '  [4] ブラウザーで開く   [5] ログ       [6] フォルダー'
    Write-Host '  [8] ショートカット作成・修復         [9] 状態更新'
    Write-Host '  [0] 管理画面を閉じる（サーバーは動作を続けます）'
    $choice = Read-Host "`n  選択"
    if ([string]::IsNullOrWhiteSpace($choice) -or $choice -eq '0') { break }
    try {
        switch ($choice) {
            '1' { Invoke-ServerAction 'Start'; [void](Read-Host 'Enterで戻る') }
            '2' { Invoke-ServerAction 'Stop'; [void](Read-Host 'Enterで戻る') }
            '3' { Invoke-ServerAction 'Restart'; [void](Read-Host 'Enterで戻る') }
            '4' { Invoke-ServerAction 'Start' }
            '5' {
                if (-not (Test-Path -LiteralPath $outLog)) { throw 'ログはまだありません。まず通常版を起動してください。' }
                Start-Process notepad.exe -ArgumentList ('"' + $outLog + '"')
                if (Test-Path -LiteralPath $errLog) { Start-Process notepad.exe -ArgumentList ('"' + $errLog + '"') }
            }
            '6' { Start-Process explorer.exe -ArgumentList ('"' + $ProjectPath + '"') }
            '8' { Invoke-ServerAction 'Shortcuts'; [void](Read-Host 'Enterで戻る') }
            '9' { }
            default { Write-Host '表示されている番号を入力してください。'; [void](Read-Host 'Enterで戻る') }
        }
    } catch { Write-Host $_.Exception.Message -ForegroundColor Red; [void](Read-Host 'Enterで戻る') }
}

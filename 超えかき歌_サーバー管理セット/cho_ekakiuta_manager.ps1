# Windows PowerShell 5.1: save this file as UTF-8 with BOM.
$ErrorActionPreference = 'Stop'
try {
    $manager = Join-Path (Split-Path $PSScriptRoot -Parent) 'scripts/manage-local-servers.ps1'
    if (-not (Test-Path -LiteralPath $manager -PathType Leaf)) {
        throw "通常版の管理スクリプトが見つかりません: $manager`nmain ブランチのファイル一式を確認してください。"
    }
    & $manager @args
    if (-not $?) { throw '管理処理に失敗しました。上に表示されたエラーを確認してください。' }
    exit 0
} catch {
    Write-Host "`n超えかき歌！の管理画面を実行できませんでした。" -ForegroundColor Red
    Write-Host $_.Exception.Message -ForegroundColor Red
    # Shortcuts call this PS1 directly, without the batch file's pause.
    if ($env:EKAKI_MANAGER_FROM_BATCH -ne '1' -and $env:EKAKI_MANAGER_NO_PAUSE -ne '1' -and -not [Console]::IsInputRedirected) {
        [void](Read-Host 'Enterで閉じる')
    }
    exit 1
}

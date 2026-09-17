param([string]$ProjectPath = (Split-Path $PSScriptRoot -Parent))

$ErrorActionPreference = 'Stop'
$ProjectPath = (Resolve-Path -LiteralPath $ProjectPath).Path
$launcher = Join-Path $ProjectPath '超えかき歌_サーバー管理セット/cho_ekakiuta_manager.ps1'
if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw "管理スクリプトが見つかりません: $launcher" }
$powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$icon = Join-Path $ProjectPath 'public/favicon.ico'
$desktop = [Environment]::GetFolderPath('Desktop')
$programs = Join-Path ([Environment]::GetFolderPath('Programs')) '超えかき歌！'
$pinned = Join-Path $env:APPDATA 'Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar'
$legacyName = '超えかき歌！_管理.bat - ショートカット.lnk'
$friendlyName = '超えかき歌！ サーバー管理.lnk'
New-Item -ItemType Directory -Path $programs -Force | Out-Null
$desktopLink = Join-Path $desktop $friendlyName
if (Test-Path -LiteralPath (Join-Path $desktop $legacyName)) { $desktopLink = Join-Path $desktop $legacyName }
$links = @($desktopLink, (Join-Path $programs $friendlyName))
# Preserve existing taskbar pins; Windows owns pinning and their order.
foreach ($name in @($legacyName, $friendlyName)) {
    $path = Join-Path $pinned $name
    if (Test-Path -LiteralPath $path) { $links += $path }
}
$shell = New-Object -ComObject WScript.Shell
try {
    foreach ($path in $links) {
        $shortcut = $shell.CreateShortcut($path)
        try {
            $shortcut.TargetPath = $powershell
            $shortcut.Arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $launcher + '"'
            $shortcut.WorkingDirectory = $ProjectPath
            $shortcut.IconLocation = $icon + ',0'
            $shortcut.Description = '超えかき歌！ 通常版の起動・停止・再起動'
            $shortcut.WindowStyle = 1
            $shortcut.Save()
            Write-Host "ショートカットを設定しました: $path"
        } finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
    }
} finally { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }

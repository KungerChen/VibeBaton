param(
    [string]$Repo = "",
    [int]$Port = 7860,
    [switch]$Browser,
    [switch]$CreateShortcut
)

$ErrorActionPreference = "Stop"

$InstallRoot = (Resolve-Path -LiteralPath (Split-Path -Parent $PSScriptRoot)).Path
if ([string]::IsNullOrWhiteSpace($Repo)) {
    $TargetRepo = $InstallRoot
} else {
    $TargetRepo = (Resolve-Path -LiteralPath $Repo).Path
}

if ($CreateShortcut) {
    $desktop = [Environment]::GetFolderPath("Desktop")
    $shortcutPath = Join-Path $desktop "VibeBaton Studio.lnk"
    $batPath = Join-Path $InstallRoot "VibeBaton-Studio.bat"
    $iconPath = Join-Path $InstallRoot "web\public\favicon.ico"

    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = $batPath
    $shortcut.WorkingDirectory = $InstallRoot
    $shortcut.Description = "Launch VibeBaton Studio (Standalone App Window)"
    if (Test-Path -LiteralPath $iconPath) {
        $shortcut.IconLocation = $iconPath
    }
    $shortcut.Save()
    Write-Host "[ok] Created Desktop shortcut: $shortcutPath"
    exit 0
}

$venvPython = Join-Path $InstallRoot ".venv\Scripts\python.exe"
if (Test-Path -LiteralPath $venvPython) {
    $PythonExe = $venvPython
} else {
    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if (-not $cmd) {
        Write-Error "Python 3.11+ was not found. Run .\scripts\install.ps1 first or ensure python is on PATH."
        exit 1
    }
    $PythonExe = $cmd.Source
}

$srcPath = Join-Path $InstallRoot "src"
if ([string]::IsNullOrWhiteSpace($env:PYTHONPATH)) {
    $env:PYTHONPATH = $srcPath
} elseif (-not ($env:PYTHONPATH -split ";" | Where-Object { $_ -eq $srcPath })) {
    $env:PYTHONPATH = "$srcPath;$($env:PYTHONPATH)"
}
$env:PYTHONUTF8 = "1"

$distIndex = Join-Path $InstallRoot "web\dist\index.html"
if (-not (Test-Path -LiteralPath $distIndex)) {
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCmd) {
        $webDir = Join-Path $InstallRoot "web"
        Write-Host "[setup] Building Studio frontend (web/dist missing)..."
        if (-not (Test-Path -LiteralPath (Join-Path $webDir "node_modules"))) {
            & $npmCmd.Source --prefix $webDir ci
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        & $npmCmd.Source --prefix $webDir run build
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } else {
        Write-Warning "web\dist\index.html is missing and npm is not installed; backend API will start without bundled Studio assets."
    }
}

$uiArgs = @("-m", "vibebaton", "ui", "--repo", $TargetRepo, "--port", "$Port")
if (-not $Browser) {
    $uiArgs += "--app"
}

Write-Host "[VibeBaton] Launching Studio for $TargetRepo on port $Port..."
& $PythonExe @uiArgs
exit $LASTEXITCODE

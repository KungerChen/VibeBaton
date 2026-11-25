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
        $shortcut.IconLocation = "$iconPath,0"
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

# Replace any lingering VibeBaton Studio UI process already holding $Port so upgrades apply cleanly.
$listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
foreach ($conn in $listeners) {
    $ownerId = $conn.OwningProcess
    if ($ownerId -le 0 -or $ownerId -eq $PID) { continue }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerId" -ErrorAction SilentlyContinue
    if ($proc -and $proc.CommandLine -match 'vibebaton\s+ui\b') {
        Write-Host "[VibeBaton] Stopping previous Studio instance (PID $ownerId) on port $Port..."
        Stop-Process -Id $ownerId -Force -ErrorAction SilentlyContinue
    }
}
$deadline = (Get-Date).AddSeconds(3)
while ((Get-Date) -lt $deadline) {
    $stillListening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    $hasBatonUi = $false
    foreach ($conn in $stillListening) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $($conn.OwningProcess)" -ErrorAction SilentlyContinue
        if ($proc -and $proc.CommandLine -match 'vibebaton\s+ui\b') { $hasBatonUi = $true }
    }
    if (-not $hasBatonUi) { break }
    Start-Sleep -Milliseconds 150
}

$webDir = Join-Path $InstallRoot "web"
$distIndex = Join-Path $webDir "dist\index.html"
$needsBuild = -not (Test-Path -LiteralPath $distIndex)
if (-not $needsBuild) {
    $distTime = (Get-Item -LiteralPath $distIndex).LastWriteTimeUtc
    $sourceCandidates = @()
    foreach ($fileName in @("index.html", "package.json")) {
        $p = Join-Path $webDir $fileName
        if (Test-Path -LiteralPath $p) { $sourceCandidates += Get-Item -LiteralPath $p }
    }
    $webSrc = Join-Path $webDir "src"
    if (Test-Path -LiteralPath $webSrc) {
        $sourceCandidates += Get-ChildItem -LiteralPath $webSrc -Recurse -File -ErrorAction SilentlyContinue
    }
    if ($sourceCandidates | Where-Object { $_.LastWriteTimeUtc -gt $distTime } | Select-Object -First 1) {
        $needsBuild = $true
    }
}

if ($needsBuild) {
    $npmCmd = Get-Command npm -ErrorAction SilentlyContinue
    if ($npmCmd) {
        Write-Host "[setup] Building Studio frontend (web/dist missing or out of date)..."
        if (-not (Test-Path -LiteralPath (Join-Path $webDir "node_modules"))) {
            & $npmCmd.Source --prefix $webDir ci
            if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        }
        & $npmCmd.Source --prefix $webDir run build
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    } else {
        Write-Warning "web\dist\index.html is missing or out of date and npm is not installed; existing assets or fallback page will be served."
    }
}

$uiArgs = @("-m", "vibebaton", "ui", "--repo", $TargetRepo, "--port", "$Port")
if (-not $Browser) {
    $uiArgs += "--app"
}

Write-Host "[VibeBaton] Launching Studio for $TargetRepo on port $Port..."
& $PythonExe @uiArgs
exit $LASTEXITCODE

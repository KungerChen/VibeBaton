#Requires -Version 5.1
<#
.SYNOPSIS
    One-click Windows installer for VibeBaton (baton).

.DESCRIPTION
    Checks the prerequisites, installs VibeBaton in editable mode into
    <RepoPath>\.venv, and verifies the baton CLI.

.PARAMETER DryRun
    Run read-only prerequisite checks and preview the installation commands.

.PARAMETER RepoPath
    Repository root to install. Defaults to the directory above scripts.

.PARAMETER SkipWeb
    Skip the optional Web UI build even when web\node_modules is present.

.PARAMETER AddToUserPath
    Add <RepoPath>\.venv\Scripts to the current user's PATH after CLI verification.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install.ps1 -DryRun
#>
param(
    [switch]$DryRun,
    [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
    [switch]$SkipWeb,
    [switch]$AddToUserPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Find-SupportedPython {
    param(
        [string]$Name,
        [string[]]$LauncherArguments = @()
    )

    $command = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $command) {
        return
    }

    # Keep a version probe from triggering an automatic install on newer Windows launchers.
    $previousAutoInstall = $env:PYTHON_MANAGER_AUTOMATIC_INSTALL
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $env:PYTHON_MANAGER_AUTOMATIC_INSTALL = 'false'
        $supported = & $command.Source @LauncherArguments -S -c 'import sys; print(sys.version_info >= (3, 11))' 2>$null
        if ('True' -ceq $supported -and $LASTEXITCODE -eq 0) {
            return $command.Source
        }
    } catch [System.Management.Automation.ApplicationFailedException] {
        # Try the next launcher if this one cannot start.
        return
    } finally {
        $env:PYTHON_MANAGER_AUTOMATIC_INSTALL = $previousAutoInstall
    }
}

function Invoke-InstallerCommand {
    param(
        [string]$Executable,
        [string[]]$Arguments,
        [string]$Preview
    )

    if ($DryRun) {
        Write-Host "DRYRUN: $Preview"
        return
    }

    & $Executable @Arguments
    if (-not $? -or $LASTEXITCODE -ne 0) {
        throw "Command failed: $Preview. Check the output above and retry."
    }
}

function Add-VenvToUserPath {
    param([string]$Directory)

    if ($DryRun) {
        Write-Host ('DRYRUN: add "{0}" to the user PATH' -f $Directory)
        return
    }

    $environmentKey = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
    try {
        # Preserve references such as %USERPROFILE% and the existing registry value type.
        $userPath = $environmentKey.GetValue('Path', $null, 'DoNotExpandEnvironmentNames')
        $kind = [Microsoft.Win32.RegistryValueKind]::String
        if ($null -ne $userPath) {
            if ($userPath -isnot [string]) {
                throw 'Repair the user PATH in Windows Environment Variables before using -AddToUserPath.'
            }
            $kind = $environmentKey.GetValueKind('Path')
        }
        $entries = $environmentKey.GetValue('Path', '') -split ';' |
            ForEach-Object { $_.Trim().Trim('"').TrimEnd('\', '/') }
        if ($entries -contains $Directory) {
            Write-Host "User PATH already contains '$Directory'."
            return
        }

        if (-not ('VibeBaton.InstallerEnvironment' -as [type])) {
            Add-Type -Namespace VibeBaton -Name InstallerEnvironment -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam,
    string lParam, uint flags, uint timeout, out UIntPtr result);

public static bool NotifyShell() {
    const int HWND_BROADCAST = 0xffff;
    const uint WM_SETTINGCHANGE = 0x001a;
    const uint SMTO_ABORTIFHUNG = 0x0002;
    UIntPtr result;
    return SendMessageTimeout(new IntPtr(HWND_BROADCAST), WM_SETTINGCHANGE, UIntPtr.Zero,
        "Environment", SMTO_ABORTIFHUNG, 100, out result) != IntPtr.Zero;
}
'@
        }

        $updatedPath = ($userPath, $Directory | Where-Object { $_ }) -join ';'
        $environmentKey.SetValue('Path', $updatedPath, $kind)
    } finally {
        $environmentKey.Dispose()
    }

    Write-Host "Added '$Directory' to the user PATH."
    if (-not [VibeBaton.InstallerEnvironment]::NotifyShell()) {
        Write-Warning 'Sign out and back in to refresh the PATH for new terminals.'
    }
}

try {
    if (-not (Test-Path -LiteralPath $RepoPath -PathType Container)) {
        throw "Repository directory '$RepoPath' was not found. Pass -RepoPath with the VibeBaton repository root."
    }
    $RepoPath = (Resolve-Path -LiteralPath $RepoPath).ProviderPath
    if (-not (Test-Path -LiteralPath (Join-Path $RepoPath 'pyproject.toml') -PathType Leaf)) {
        throw "No pyproject.toml in '$RepoPath'. Pass -RepoPath with the VibeBaton repository root."
    }

    Write-Host '[1/6] Checking Python 3.11 or newer'
    $pythonLabel = 'python'
    $pythonArguments = @()
    $python = Find-SupportedPython 'python'
    if (-not $python) {
        $pythonLabel = 'py -3'
        $pythonArguments = @('-3')
        $python = Find-SupportedPython 'py' $pythonArguments
    }
    if (-not $python) {
        throw 'Install Python 3.11 or newer from https://www.python.org/downloads/windows/ and make python or py -3 available in a new terminal.'
    }
    Write-Host "Found Python 3.11 or newer via $pythonLabel."

    Write-Host '[2/6] Checking Git'
    $git = Get-Command -Name git -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $git) {
        throw 'Install Git for Windows from https://git-scm.com/download/win and make git available in a new terminal.'
    }
    try {
        & $git.Source --version
        $gitAvailable = $? -and $LASTEXITCODE -eq 0
    } catch [System.Management.Automation.ApplicationFailedException] {
        $gitAvailable = $false
    }
    if (-not $gitAvailable) {
        throw 'git --version failed. Repair Git for Windows and try again.'
    }

    Write-Host '[3/6] Checking the optional Web UI build'
    $node = Get-Command -Name node -CommandType Application -ErrorAction SilentlyContinue
    $npm = Get-Command -Name npm.cmd -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    $webRoot = Join-Path $RepoPath 'web'
    if ($SkipWeb) {
        Write-Host 'Skipping the Web UI build (-SkipWeb).'
    } elseif ($null -eq $node -or $null -eq $npm) {
        Write-Host 'Skipping the Web UI build. Node.js and npm.cmd are required to build it.'
    } elseif (-not (Test-Path -LiteralPath (Join-Path $webRoot 'node_modules') -PathType Container)) {
        Write-Host 'Skipping the Web UI build. Provide web\node_modules to enable it.'
    } else {
        Write-Host 'Web UI can be built using the existing web\node_modules.'
        if ($DryRun) {
            Write-Host ('DRYRUN: npm.cmd run build (in "{0}")' -f $webRoot)
        } else {
            Push-Location -LiteralPath $webRoot
            try {
                Invoke-InstallerCommand $npm.Source @('run', 'build') 'npm.cmd run build'
            } catch {
                throw "$($_.Exception.Message) Pass -SkipWeb to install just the CLI."
            } finally {
                Pop-Location
            }
        }
    }

    Write-Host '[4/6] Preparing the repository virtual environment'
    $venvPath = Join-Path $RepoPath '.venv'
    $venvScripts = Join-Path $venvPath 'Scripts'
    $venvPython = Join-Path $venvScripts 'python.exe'
    $venvBaton = Join-Path $venvScripts 'baton.exe'
    if ((Test-Path -LiteralPath $venvPython -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $venvPath 'pyvenv.cfg') -PathType Leaf)) {
        Write-Host "Reusing '$venvPath'."
    } else {
        $arguments = $pythonArguments + @('-m', 'venv', $venvPath)
        $preview = '{0} -m venv "{1}"' -f $pythonLabel, $venvPath
        Invoke-InstallerCommand $python $arguments $preview
    }

    Write-Host '[5/6] Installing VibeBaton in editable mode'
    $preview = '& "{0}" -m pip install -e "{1}"' -f $venvPython, $RepoPath
    Invoke-InstallerCommand $venvPython @('-m', 'pip', 'install', '-e', $RepoPath) $preview

    Write-Host '[6/6] Verifying the CLI from the virtual environment'
    Invoke-InstallerCommand $venvBaton @('--version') 'baton --version'
    Invoke-InstallerCommand $venvBaton @('doctor', '--help') 'baton doctor --help' | Out-Null

    if ($AddToUserPath) {
        Add-VenvToUserPath $venvScripts
    }

    if ($DryRun) {
        Write-Host "Dry run complete. Planned CLI at '$venvBaton'."
    } else {
        Write-Host "Installation complete. CLI verified at '$venvBaton'."
    }
    exit 0
} catch {
    [Console]::Error.WriteLine("ERROR: $($_.Exception.Message)")
    exit 1
}

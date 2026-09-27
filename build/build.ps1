<#
    Parish Music Player - build script.

    Run from the project root in PowerShell:

        .\build\build.ps1

    Steps performed:
      1. create or reuse a virtual environment in .venv
      2. install the pinned dependencies
      3. refresh the soundfont manifest
      4. run PyInstaller against build/parish_music_player.spec
      5. smoke-test the resulting executable
      6. optionally build the Inno Setup installer

    Switches:
      -Clean       delete build/ and dist/ output first
      -Installer   also compile build/installer.iss with Inno Setup
      -SkipTest    do not launch the executable afterwards
#>

[CmdletBinding()]
param(
    [switch]$Clean,
    [switch]$Installer,
    [switch]$SkipTest
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($message) { Write-Host "`n==> $message" -ForegroundColor Cyan }

# -- 1. Virtual environment ---------------------------------------------------
Step 'Preparing the virtual environment'
$venv = Join-Path $root '.venv'
$python = Join-Path $venv 'Scripts\python.exe'

if (-not (Test-Path $python)) {
    Write-Host 'Creating .venv'
    py -3.11 -m venv $venv
    if (-not (Test-Path $python)) { throw "Could not create a virtual environment at $venv" }
}

# -- 2. Dependencies ----------------------------------------------------------
Step 'Installing dependencies'
& $python -m pip install --upgrade pip --quiet
& $python -m pip install -r (Join-Path $root 'requirements.txt') --quiet
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }

# -- 3. Soundfont manifest ----------------------------------------------------
Step 'Refreshing the soundfont manifest'
& $python (Join-Path $root 'generate_manifest.py') (Join-Path $root 'src\soundfonts')
if ($LASTEXITCODE -ne 0) { throw 'No soundfonts found in src\soundfonts' }

# -- 4. Clean --------------------------------------------------------------
if ($Clean) {
    Step 'Removing previous build output'
    foreach ($dir in @('dist', 'build\ParishMusicPlayer', 'Output')) {
        $path = Join-Path $root $dir
        if (Test-Path $path) { Remove-Item $path -Recurse -Force }
    }
}

# -- 5. PyInstaller -----------------------------------------------------------
Step 'Building the executable'
& $python -m PyInstaller (Join-Path $root 'build\parish_music_player.spec') --noconfirm --distpath (Join-Path $root 'dist')
if ($LASTEXITCODE -ne 0) { throw 'PyInstaller failed' }

$exe = Join-Path $root 'dist\ParishMusicPlayer\ParishMusicPlayer.exe'
if (-not (Test-Path $exe)) { throw "Expected executable not found at $exe" }

$sizeMb = [math]::Round((Get-ChildItem (Split-Path $exe) -Recurse |
                         Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Write-Host "Built $exe ($sizeMb MB total)" -ForegroundColor Green

# Confirm the assets the player cannot start without actually made it in.
Step 'Checking bundled assets'
$bundle = Join-Path $root 'dist\ParishMusicPlayer\_internal\src'
if (-not (Test-Path $bundle)) { $bundle = Join-Path $root 'dist\ParishMusicPlayer\src' }
foreach ($required in @('index.html', 'js\main.js', 'css\app.css', 'logo.png')) {
    $path = Join-Path $bundle $required
    if (-not (Test-Path $path)) { throw "Missing from the bundle: $required" }
}
$fonts = @(Get-ChildItem (Join-Path $bundle 'soundfonts') -Filter '*-mp3.js' -ErrorAction SilentlyContinue)
if ($fonts.Count -eq 0) { throw 'No soundfonts were bundled' }
Write-Host "All assets present, including $($fonts.Count) instrument(s)" -ForegroundColor Green

# -- 6. Smoke test ------------------------------------------------------------
if (-not $SkipTest) {
    Step 'Smoke-testing the executable'
    $proc = Start-Process -FilePath $exe -PassThru
    Start-Sleep -Seconds 6
    if ($proc.HasExited) {
        $log = "$env:LOCALAPPDATA\ParishMusicPlayer\player.log"
        if (Test-Path $log) { Get-Content $log -Tail 30 }
        throw "The executable exited immediately (code $($proc.ExitCode)). See $log"
    }
    Stop-Process -Id $proc.Id -Force
    Write-Host 'The player started and stayed running' -ForegroundColor Green
}

# -- 7. Installer -------------------------------------------------------------
if ($Installer) {
    Step 'Building the Windows installer'
    # Inno Setup can be installed for all users, which needs an administrator,
    # or just for the person building, which does not. Look in both places, so
    # the build works without anyone having to find an admin password.
    $iscc = @(
        "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
        "$env:ProgramFiles\Inno Setup 6\ISCC.exe",
        "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe"
    ) | Where-Object { Test-Path $_ } | Select-Object -First 1

    if (-not $iscc) {
        Write-Warning 'Inno Setup 6 not found. Install it from https://jrsoftware.org/isdl.php'
    } else {
        & $iscc (Join-Path $root 'build\installer.iss')
        if ($LASTEXITCODE -ne 0) { throw 'Inno Setup failed' }
        Write-Host "Installer written to $(Join-Path $root 'Output')" -ForegroundColor Green
    }
}

Step 'Done'

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = $PSScriptRoot
$frontendDir = Join-Path $projectRoot "frontend"
$backendDir = Join-Path $projectRoot "backend"
$frontendDistDir = Join-Path $frontendDir "dist"
$backendVenvPython = Join-Path $backendDir "venv\Scripts\python.exe"
$backendRequirements = Join-Path $backendDir "requirements.txt"
$backendDepsStamp = Join-Path $backendDir ".deps_installed.stamp"
$backendOpenCvWheelPattern = "opencv_contrib_python-*.whl"
$backendWheelhouseDir = Join-Path $backendDir "wheelhouse"
$torchVersion = "2.5.1"
$torchVisionVersion = "0.20.1"
$torchAudioVersion = "2.5.1"
$frontendPackageJson = Join-Path $frontendDir "package.json"
$frontendPackageLock = Join-Path $frontendDir "package-lock.json"
$frontendNodeModules = Join-Path $frontendDir "node_modules"
$frontendDepsStamp = Join-Path $frontendDir ".deps_installed.stamp"
$backendPort = 8000
$backendHost = "127.0.0.1"
$frontendUrl = "http://localhost/"
$backendHealthUrl = "http://127.0.0.1:$backendPort/api/health"
$postgresServiceName = "postgresql-x64-16"

function Write-Step {
    param([string]$Message)
    Write-Host ""
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Find-CommandPath {
    param([string[]]$Candidates)

    foreach ($candidate in $Candidates) {
        $command = Get-Command $candidate -ErrorAction SilentlyContinue
        if ($command) {
            return $command.Source
        }
    }

    return $null
}

function Test-ListeningPort {
    param([int]$Port)

    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
        Select-Object -First 1
    return $null -ne $listener
}

function Minimize-ProcessWindow {
    param(
        [System.Diagnostics.Process]$Process
    )

    if (-not $Process) {
        return
    }

    Add-Type -Namespace Win32 -Name NativeMethods -MemberDefinition @"
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool ShowWindowAsync(System.IntPtr hWnd, int nCmdShow);
"@ -ErrorAction SilentlyContinue | Out-Null

    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        try {
            $Process.Refresh()
        }
        catch {
        }

        if ($Process.MainWindowHandle -ne 0) {
            [void][Win32.NativeMethods]::ShowWindowAsync($Process.MainWindowHandle, 2)
            return
        }

        Start-Sleep -Milliseconds 500
    }
}

function Wait-UrlReady {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 5
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                return $true
            }
        }
        catch {
        }

        Start-Sleep -Seconds 1
    }

    return $false
}

function Resolve-NginxRoot {
    if ($env:NGINX_ROOT) {
        return $env:NGINX_ROOT
    }

    $searchRoots = @(
        $projectRoot
        (Split-Path -Parent $projectRoot)
    ) | Select-Object -Unique

    foreach ($searchRoot in $searchRoots) {
        $candidate = Get-ChildItem -Path $searchRoot -Directory -Filter "nginx-*" -ErrorAction SilentlyContinue |
            Sort-Object Name -Descending |
            Select-Object -First 1

        if ($candidate) {
            return $candidate.FullName
        }
    }

    return $null
}

function Ensure-PostgresServiceStarted {
    param([string]$ServiceName)

    $service = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if (-not $service) {
        throw "Required PostgreSQL service '$ServiceName' was not found. Install PostgreSQL 16.x before starting the system."
    }

    if ($service.Status -eq "Running") {
        Write-Host "PostgreSQL service '$ServiceName' is already running." -ForegroundColor Green
        return
    }

    Write-Host "Starting PostgreSQL service '$ServiceName'..." -ForegroundColor Yellow
    Start-Service -Name $ServiceName
    $service.WaitForStatus("Running", [TimeSpan]::FromSeconds(20))
    Write-Host "PostgreSQL service '$ServiceName' is now running." -ForegroundColor Green
}

function Get-ItemWriteTimeOrMin {
    param([string]$Path)

    if (Test-Path $Path) {
        return (Get-Item $Path).LastWriteTimeUtc
    }

    return [datetime]::MinValue
}

function Resolve-BackendOpenCvWheel {
    $wheel = Get-ChildItem -Path $backendDir -File -Filter $backendOpenCvWheelPattern -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1

    return $wheel
}

function Test-BackendWheelhouseHasTorchPackages {
    if (-not (Test-Path $backendWheelhouseDir)) {
        return $false
    }

    $requiredPatterns = @(
        "torch-$torchVersion*whl"
        "torchvision-$torchVisionVersion*whl"
        "torchaudio-$torchAudioVersion*whl"
    )

    foreach ($pattern in $requiredPatterns) {
        $match = Get-ChildItem -Path $backendWheelhouseDir -File -Filter $pattern -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $match) {
            return $false
        }
    }

    return $true
}

function Test-BackendDepsNeedInstall {
    if (-not (Test-Path $backendRequirements)) {
        throw "requirements.txt was not found at '$backendRequirements'."
    }

    if (-not (Test-Path $backendDepsStamp)) {
        return $true
    }

    $depsStampWriteTime = (Get-Item $backendDepsStamp).LastWriteTimeUtc
    if ((Get-Item $backendRequirements).LastWriteTimeUtc -gt $depsStampWriteTime) {
        return $true
    }

    $opencvWheel = Resolve-BackendOpenCvWheel
    if ($opencvWheel -and $opencvWheel.LastWriteTimeUtc -gt $depsStampWriteTime) {
        return $true
    }

    return $false
}

function Ensure-BackendVenv {
    param([string]$BootstrapPython)

    if (Test-Path $backendVenvPython) {
        Write-Host "Backend virtual environment already exists." -ForegroundColor Green
        return
    }

    if (-not $BootstrapPython) {
        throw "Python is not available. Install Python and add it to PATH so the backend virtual environment can be created."
    }

    Write-Host "Creating backend virtual environment..." -ForegroundColor Yellow
    Push-Location $backendDir
    try {
        & $BootstrapPython -m venv venv
    }
    finally {
        Pop-Location
    }

    if (-not (Test-Path $backendVenvPython)) {
        throw "Backend virtual environment creation did not produce '$backendVenvPython'."
    }

    Write-Host "Backend virtual environment created." -ForegroundColor Green
}

function Test-FrontendDepsNeedInstall {
    if (-not (Test-Path $frontendPackageJson)) {
        throw "package.json was not found at '$frontendPackageJson'."
    }

    if (-not (Test-Path $frontendNodeModules)) {
        return $true
    }

    if (-not (Test-Path $frontendDepsStamp)) {
        return $true
    }

    $latestConfigWrite = @(
        Get-ItemWriteTimeOrMin $frontendPackageJson
        Get-ItemWriteTimeOrMin $frontendPackageLock
    ) | Sort-Object -Descending | Select-Object -First 1

    return $latestConfigWrite -gt (Get-Item $frontendDepsStamp).LastWriteTimeUtc
}

Write-Step "Checking required tools"

$bootstrapPython = $null
if (Test-Path $backendVenvPython) {
    $bootstrapPython = $backendVenvPython
}
else {
    $bootstrapPython = Find-CommandPath @("python", "py")
}

if (-not $bootstrapPython) {
    throw "Python is not available. Install Python and add it to PATH."
}

$nodeExe = Find-CommandPath @("node")
if (-not $nodeExe) {
    throw "Node.js is not installed or not available in PATH."
}

$npmExe = Find-CommandPath @("npm")
if (-not $npmExe) {
    throw "npm is not installed or not available in PATH."
}

$ffmpegExe = Find-CommandPath @("ffmpeg")
if (-not $ffmpegExe) {
    throw "FFmpeg is not installed or not available in PATH."
}

$nginxRoot = Resolve-NginxRoot
if (-not $nginxRoot) {
    throw "Could not find an nginx folder in the project root or its parent. Set NGINX_ROOT or place nginx under one of those locations."
}

$nginxExe = Join-Path $nginxRoot "nginx.exe"
if (-not (Test-Path $nginxExe)) {
    throw "nginx.exe was not found at '$nginxExe'."
}

$nginxConf = Join-Path $nginxRoot "conf\nginx.conf"
if (-not (Test-Path $nginxConf)) {
    throw "nginx.conf was not found at '$nginxConf'."
}

Write-Host "Python : $bootstrapPython"
Write-Host "Node   : $nodeExe"
Write-Host "npm    : $npmExe"
Write-Host "FFmpeg : $ffmpegExe"
Write-Host "Nginx  : $nginxExe"

Write-Step "Checking PostgreSQL service"
Ensure-PostgresServiceStarted -ServiceName $postgresServiceName

Write-Step "Checking backend virtual environment"
Ensure-BackendVenv -BootstrapPython $bootstrapPython
$pythonExe = $backendVenvPython
$backendOpenCvWheel = Resolve-BackendOpenCvWheel

Write-Step "Checking backend dependencies"
Push-Location $backendDir
try {
    if (Test-BackendDepsNeedInstall) {
        if (-not $backendOpenCvWheel) {
            throw "No OpenCV wheel matching '$backendOpenCvWheelPattern' was found in '$backendDir'. Place the wheel file there before starting deployment."
        }

        Write-Host "Installing OpenCV wheel: $($backendOpenCvWheel.Name)" -ForegroundColor Yellow
        & $pythonExe -m pip install $backendOpenCvWheel.FullName

        Write-Host "Reinstalling SciPy 1.11.4" -ForegroundColor Yellow
        & $pythonExe -m pip install "scipy==1.11.4" --force-reinstall --no-cache-dir

        if (Test-BackendWheelhouseHasTorchPackages) {
            Write-Host "Installing PyTorch CUDA 12.1 packages from local wheelhouse: $backendWheelhouseDir" -ForegroundColor Yellow
            & $pythonExe -m pip install --no-index --find-links $backendWheelhouseDir "torch==$torchVersion" "torchvision==$torchVisionVersion" "torchaudio==$torchAudioVersion"
        }
        else {
            Write-Host "Local wheelhouse missing one or more PyTorch wheels. Falling back to PyTorch website." -ForegroundColor Yellow
            & $pythonExe -m pip install "torch==$torchVersion" "torchvision==$torchVisionVersion" "torchaudio==$torchAudioVersion" --index-url https://download.pytorch.org/whl/cu121
        }

        Write-Host "Installing Python packages from requirements.txt" -ForegroundColor Yellow
        & $pythonExe -m pip install -r requirements.txt

        Set-Content -Path $backendDepsStamp -Value (Get-Date).ToString("o") -NoNewline
    }
    else {
        Write-Host "Python packages already up to date. Skipping pip install." -ForegroundColor Green
    }

    Write-Step "Running database migrations"
    & $pythonExe -m alembic upgrade head
}
finally {
    Pop-Location
}

Write-Step "Checking frontend dependencies"
Push-Location $frontendDir
try {
    if (Test-FrontendDepsNeedInstall) {
        Write-Host "Installing npm packages" -ForegroundColor Yellow
        & $npmExe install
        Set-Content -Path $frontendDepsStamp -Value (Get-Date).ToString("o") -NoNewline
    }
    else {
        Write-Host "npm packages already up to date. Skipping npm install." -ForegroundColor Green
    }

    Write-Step "Building frontend"
    & $npmExe run build
}
finally {
    Pop-Location
}

if (-not (Test-Path (Join-Path $frontendDistDir "index.html"))) {
    throw "Frontend build did not produce '$frontendDistDir\index.html'."
}

Write-Step "Validating Nginx configuration"
Push-Location $nginxRoot
try {
    & .\nginx.exe -t
}
finally {
    Pop-Location
}

Write-Step "Starting backend"
$backendProcess = $null
if (Test-ListeningPort -Port $backendPort) {
    Write-Host "Port $backendPort is already listening. Skipping backend start." -ForegroundColor Yellow
}
else {
    $backendCommand = @"
`$Host.UI.RawUI.WindowTitle = 'CV Project Backend'
Set-Location '$backendDir'
& '$pythonExe' -m uvicorn main:app --host $backendHost --port $backendPort
"@
    $backendProcess = Start-Process powershell.exe -ArgumentList @(
        "-NoExit",
        "-ExecutionPolicy", "Bypass",
        "-Command", $backendCommand
    ) -PassThru
}

Write-Step "Starting Nginx"
$nginxRunning = Get-Process -Name "nginx" -ErrorAction SilentlyContinue
if ($nginxRunning) {
    Push-Location $nginxRoot
    try {
        & .\nginx.exe -s reload
        Write-Host "Nginx was already running, so it was reloaded." -ForegroundColor Yellow
    }
    finally {
        Pop-Location
    }
}
else {
    Start-Process -FilePath $nginxExe -WorkingDirectory $nginxRoot | Out-Null
    Start-Sleep -Seconds 2
}

Write-Step "Done"
Write-Host "Frontend URL : $frontendUrl"
Write-Host "Backend URL  : http://127.0.0.1:$backendPort/api/health"
Write-Host "Nginx root   : $nginxRoot"
Write-Host ""
Write-Host "If backend was already running on another port, update nginx.conf or stop the old process first." -ForegroundColor Yellow

Write-Step "Opening browser"
if (Wait-UrlReady -Url $backendHealthUrl -TimeoutSeconds 30) {
    if ($backendProcess) {
        Minimize-ProcessWindow -Process $backendProcess
    }
    Start-Process $frontendUrl
}
else {
    Write-Host "App did not become ready in time, so the browser was not opened automatically." -ForegroundColor Yellow
}

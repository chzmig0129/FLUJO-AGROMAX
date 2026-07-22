<#
.SYNOPSIS
  Provisioning reproducible de FLUJO-AGROMAX en Windows (Ryzen 3950X, RTX 2060 6GB).

.DESCRIPTION
  Verifica que node/python/ffmpeg/git estén disponibles en PATH, crea (si no
  existe) el entorno virtual .venv-whisper con faster-whisper + las libs CUDA
  de NVIDIA que necesita ctranslate2, detecta la ruta de esas DLLs dentro del
  venv, y genera .env.local con la configuración recomendada para esta PC.

  Es idempotente: se puede correr varias veces sin romper nada. Si .venv-whisper
  o .env.local ya existen, no los recrea (solo informa).

.USAGE
  pwsh -NoProfile -File scripts\setup-windows.ps1
#>

[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

# Nos posicionamos en la raíz del repo (un nivel arriba de scripts/).
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Write-Step {
    param([string]$Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Message)
    Write-Host "    OK: $Message" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Message)
    Write-Host "    ADVERTENCIA: $Message" -ForegroundColor Yellow
}

function Assert-CommandOnPath {
    param(
        [string]$Name,
        [string]$InstallHint
    )

    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $cmd) {
        Write-Host "    FALTA: '$Name' no está en PATH. $InstallHint" -ForegroundColor Red
        throw "Prerrequisito faltante: $Name"
    }

    Write-Ok "$Name encontrado en $($cmd.Source)"
    return $cmd
}

# ---------------------------------------------------------------------------
# 1. Verificar prerrequisitos en PATH
# ---------------------------------------------------------------------------
Write-Step "Verificando prerrequisitos (node, python, ffmpeg, git)..."

$nodeCmd = Assert-CommandOnPath -Name "node" `
    -InstallHint "Instalá Node.js 24.x desde https://nodejs.org/ y reabrí la terminal."
$pythonCmd = Assert-CommandOnPath -Name "python" `
    -InstallHint "Instalá Python 3.12 desde https://www.python.org/ (marcá 'Add python.exe to PATH')."
$ffmpegCmd = Assert-CommandOnPath -Name "ffmpeg" `
    -InstallHint "Instalá el build 'gyan full' de ffmpeg y agregá su carpeta bin\ a PATH."
$gitCmd = Assert-CommandOnPath -Name "git" `
    -InstallHint "Instalá Git desde https://git-scm.com/download/win."

$nodeVersion = (& node --version).Trim()
$pythonVersion = (& python --version).Trim()
Write-Ok "node $nodeVersion"
Write-Ok "$pythonVersion"

# ---------------------------------------------------------------------------
# 2. Crear el entorno virtual .venv-whisper si no existe
# ---------------------------------------------------------------------------
Write-Step "Preparando entorno virtual .venv-whisper..."

$VenvDir = Join-Path $RepoRoot ".venv-whisper"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"
$VenvPip = Join-Path $VenvDir "Scripts\pip.exe"

if (-not (Test-Path $VenvDir)) {
    Write-Host "    Creando entorno virtual en $VenvDir..."
    & python -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) {
        throw "Falló 'python -m venv $VenvDir'"
    }
    Write-Ok "Entorno virtual creado."
} else {
    Write-Ok "$VenvDir ya existe, se reutiliza."
}

if (-not (Test-Path $VenvPython)) {
    throw "No se encontró $VenvPython tras crear el venv; algo salió mal."
}

# ---------------------------------------------------------------------------
# 3. Instalar/actualizar dependencias de Python en el venv
# ---------------------------------------------------------------------------
Write-Step "Instalando dependencias de transcripción (faster-whisper + CUDA libs)..."

& $VenvPython -m pip install --upgrade pip
if ($LASTEXITCODE -ne 0) { throw "Falló la actualización de pip" }

& $VenvPip install --upgrade faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12
if ($LASTEXITCODE -ne 0) { throw "Falló la instalación de faster-whisper/nvidia-cublas-cu12/nvidia-cudnn-cu12" }

Write-Ok "Dependencias de Python instaladas/actualizadas."

# ---------------------------------------------------------------------------
# 4. Detectar la ruta de las DLLs cudnn/cublas dentro del venv
# ---------------------------------------------------------------------------
Write-Step "Detectando rutas de las DLLs de NVIDIA (cublas/cudnn) dentro del venv..."

$NvidiaRoot = Join-Path $VenvDir "Lib\site-packages\nvidia"
$CudaDllDirs = @()

if (Test-Path $NvidiaRoot) {
    $CudaDllDirs = Get-ChildItem -Path $NvidiaRoot -Directory |
        ForEach-Object { Join-Path $_.FullName "bin" } |
        Where-Object { Test-Path $_ }
}

if ($CudaDllDirs.Count -eq 0) {
    Write-Warn "No se encontraron carpetas 'bin' bajo $NvidiaRoot. Revisá la instalación de nvidia-cublas-cu12/nvidia-cudnn-cu12."
} else {
    Write-Ok "DLLs de NVIDIA encontradas en:"
    foreach ($dir in $CudaDllDirs) {
        Write-Host "      - $dir"
    }
}

# ---------------------------------------------------------------------------
# 5. Generar .env.local si no existe
# ---------------------------------------------------------------------------
Write-Step "Generando .env.local..."

$EnvLocalPath = Join-Path $RepoRoot ".env.local"

if (Test-Path $EnvLocalPath) {
    Write-Ok "$EnvLocalPath ya existe, no se sobrescribe."
} else {
    $ffmpegPath = (Get-Command ffmpeg).Source
    $pythonBinPath = (Resolve-Path $VenvPython).Path

    $envLines = @(
        "TRANSCRIBE_ENGINE=faster",
        "PYTHON_BIN=$pythonBinPath",
        "FFMPEG_BIN=$ffmpegPath",
        "PROXY_ENCODER=h264_nvenc",
        "TRANSCRIBE_CONCURRENCY=1",
        "WHISPER_BATCH_SIZE=8",
        "PROXY_CONCURRENCY=4",
        "FRAMES_CONCURRENCY=8"
    )

    if ($CudaDllDirs.Count -gt 0) {
        $envLines += "# DLLs CUDA detectadas (agregalas a PATH de sesión si faster-whisper no las encuentra):"
        foreach ($dir in $CudaDllDirs) {
            $envLines += "# $dir"
        }
    }

    Set-Content -Path $EnvLocalPath -Value $envLines -Encoding UTF8
    Write-Ok "$EnvLocalPath generado."
}

# ---------------------------------------------------------------------------
# 6. Siguiente paso
# ---------------------------------------------------------------------------
Write-Step "Setup completo."
Write-Host ""
Write-Host "Siguiente paso:" -ForegroundColor Cyan
Write-Host "    npm install && npm run dev" -ForegroundColor White
Write-Host ""
Write-Host "Ver WINDOWS.md para detalles sobre las DLLs de CUDA y cómo verificar la GPU."

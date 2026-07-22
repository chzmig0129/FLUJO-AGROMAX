# Despliegue en Windows (PC de producción)

Esta guía documenta cómo preparar FLUJO-AGROMAX en la PC de producción con
Windows 10/11, un Ryzen 9 3950X (16c/32t), una RTX 2060 de 6GB (driver
591.86), 64GB de RAM, ffmpeg 8.0.1 (build "gyan full") en PATH, Node
v24.13.0, Python 3.12.10 y git 2.53. El repo vive en `C:\FLUJO-AGROMAX`.

Hay dos caminos: correr el script automático (`scripts\setup-windows.ps1`)
o seguir los pasos manuales de abajo. El script hace exactamente lo que
describen los pasos manuales, así que esta guía sirve también como
referencia si algo falla y hay que resolverlo a mano.

## Camino rápido: script automático

```powershell
cd C:\FLUJO-AGROMAX
pwsh -NoProfile -File scripts\setup-windows.ps1
```

El script es idempotente: se puede correr varias veces sin romper nada.
Verifica que `node`, `python`, `ffmpeg` y `git` estén en PATH, crea (o
reutiliza) `.venv-whisper`, instala/actualiza las dependencias de Python,
detecta las DLLs de CUDA dentro del venv y genera `.env.local` si no
existe. Al final imprime el siguiente paso: `npm install && npm run dev`.

## Pasos manuales equivalentes

### 1. Verificar prerrequisitos en PATH

```powershell
node --version    # v24.13.0
python --version  # Python 3.12.10
ffmpeg -version   # ffmpeg version 8.0.1 ... (build gyan full)
git --version     # git version 2.53...
```

Si alguno falla, instalar/agregar a PATH y reabrir la terminal antes de
continuar.

### 2. Crear el entorno virtual de Python para faster-whisper

```powershell
cd C:\FLUJO-AGROMAX
python -m venv .venv-whisper
```

Si `.venv-whisper` ya existe, se reutiliza tal cual (no hace falta
borrarlo).

### 3. Instalar las dependencias de transcripción

```powershell
.venv-whisper\Scripts\pip install --upgrade pip
.venv-whisper\Scripts\pip install --upgrade faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12
```

`faster-whisper` usa `ctranslate2` por debajo, que en GPU necesita las
librerías `cuBLAS` y `cuDNN` de NVIDIA. En vez de instalar el CUDA
Toolkit completo del sistema, se instalan como paquetes `pip`
(`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`) dentro del propio venv — así
el setup queda autocontenido y no depende de una instalación global de
CUDA.

### 4. Ubicar las DLLs de cuBLAS/cuDNN dentro del venv

Tras el paso anterior, las DLLs quedan bajo:

```
.venv-whisper\Lib\site-packages\nvidia\cublas\bin\
.venv-whisper\Lib\site-packages\nvidia\cudnn\bin\
```

`ctranslate2` necesita poder cargar esas DLLs en tiempo de ejecución.
Hay dos formas de exponerlas al proceso Python del venv:

**Opción A — PATH de sesión (recomendada, no requiere tocar código):**

Antes de correr `npm run dev` (o cualquier proceso que invoque al
Python del venv), anteponer esas carpetas al `PATH` de la sesión actual
de PowerShell:

```powershell
$cublasBin = Resolve-Path ".venv-whisper\Lib\site-packages\nvidia\cublas\bin"
$cudnnBin  = Resolve-Path ".venv-whisper\Lib\site-packages\nvidia\cudnn\bin"
$env:PATH = "$cublasBin;$cudnnBin;$env:PATH"
```

Esto solo afecta a la ventana de PowerShell actual (y a los procesos
hijos que lance, como `npm run dev`). Hay que repetirlo cada vez que se
abre una terminal nueva, o agregarlo al perfil de PowerShell
(`$PROFILE`) si se quiere permanente.

**Opción B — `os.add_dll_directory` dentro del propio script Python:**

Alternativamente, se puede resolver desde código Python (por ejemplo al
inicio de `scripts/transcribe_faster.py`) llamando a
`os.add_dll_directory(ruta)` con las mismas dos rutas, lo cual evita
depender del PATH de la terminal. Esta guía documenta la opción A
(PATH de sesión) porque no requiere modificar código existente; la
opción B queda anotada aquí como alternativa si en el futuro se decide
cablearlo en el propio script.

`scripts\setup-windows.ps1` detecta estas rutas automáticamente y las
deja comentadas al final de `.env.local` como referencia.

### 5. Generar `.env.local`

Si no existe, crear `C:\FLUJO-AGROMAX\.env.local` con:

```
TRANSCRIBE_ENGINE=faster
PYTHON_BIN=C:\FLUJO-AGROMAX\.venv-whisper\Scripts\python.exe
FFMPEG_BIN=<ruta de ffmpeg detectada con (Get-Command ffmpeg).Source>
PROXY_ENCODER=h264_nvenc
TRANSCRIBE_CONCURRENCY=1
WHISPER_BATCH_SIZE=8
PROXY_CONCURRENCY=4
FRAMES_CONCURRENCY=8
```

### 6. Instalar dependencias de Node y levantar el proyecto

```powershell
npm install
npm run dev
```

## Racional del tuning

- **`TRANSCRIBE_CONCURRENCY=1` + `WHISPER_BATCH_SIZE=8`**: la RTX 2060
  tiene solo 6GB de VRAM. El modelo `large-v3-turbo` de faster-whisper ya
  ocupa una porción significativa de esa memoria, así que correr más de
  una instancia de Whisper en paralelo arriesga quedarse sin VRAM
  (`CUDA out of memory`). En cambio, batchear internamente (8 segmentos
  por pasada) aprovecha mejor la GPU disponible sin necesitar una
  segunda instancia del modelo cargada en memoria.
- **`PROXY_ENCODER=h264_nvenc` + `PROXY_CONCURRENCY=4`**: `nvenc` es el
  encoder de video acelerado por hardware de NVIDIA (incluido en el
  build "gyan full" de ffmpeg). Al mover la codificación de los proxies
  del CPU a un bloque dedicado de la GPU, libera los 16 núcleos/32 hilos
  del Ryzen 3950X para otras etapas del pipeline (transcripción,
  extracción de frames, etc.), permitiendo correr varios proxies en
  paralelo sin saturar el CPU.
- **`FRAMES_CONCURRENCY=8`**: la extracción de frames es CPU-bound y
  liviana por tarea; con 16 núcleos físicos disponibles (y liberados en
  parte gracias a `nvenc`), 8 extracciones concurrentes es un punto
  intermedio razonable sin saturar el sistema mientras corren las otras
  etapas.

## Verificar que faster-whisper ve la GPU

Con el venv activo (o llamando directamente al Python del venv):

```powershell
.venv-whisper\Scripts\python.exe -c "import ctranslate2; print(ctranslate2.get_cuda_device_count())"
```

Si imprime `1` (o más), `ctranslate2` detecta la GPU correctamente y
`faster-whisper` puede usar `device="cuda"`. Si imprime `0`, revisar:

1. Que el driver NVIDIA esté actualizado (591.86 o superior).
2. Que las DLLs de cuBLAS/cuDNN estén en PATH (ver paso 4 arriba) *antes*
   de invocar Python en esa misma sesión de terminal.
3. Que `nvidia-cublas-cu12` y `nvidia-cudnn-cu12` se hayan instalado sin
   errores dentro de `.venv-whisper` (repetir el paso 3 si hace falta).

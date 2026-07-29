# FLUJO V2 — contrato del nuevo flujo

> **Léelo al inicio de cada sesión.** Es la fuente de verdad de hacia dónde va el
> sistema. El estado de lo YA construido (v1, 16 etapas) está en [ESTADO.md](ESTADO.md);
> este documento define qué cambia y en qué orden.

## Por qué existe un v2

La corrida v1 de OVINOS (43 clases, ~211 min) **funcionó** — entrega completa,
3 gates en verde — pero tomó ~1 semana con niñera, corriendo todo de un jalón en
la PC (`ssh itg`). Diagnóstico verificado:

1. **Render (Remotion) era el cuello de botella**: Chrome rasteriza por software,
   GPU al 0 %, libx264 en CPU, 13–18 GB de frames temporales por clase (de ahí el
   incidente del disco lleno), ~tiempo real o peor.
2. **Transcripción mal operada, no mal elegida**: faster-whisper large-v3-turbo es
   el motor correcto, pero se relanzaba el proceso (y recargaba el modelo, 15–30 s)
   por CADA clip, y `device="auto"` podía caer a CPU en silencio.
3. **Corrida monolítica**: 4 h de contenido de una pasada — cualquier falla a la
   mitad cuesta carísimo detectar y recuperar.

## Principios v2

- **Mismas 16 etapas, mismos artefactos por job** (`jobs/<id>/…`). No se
  reconstruye el pipeline; se cambian los motores lentos y la forma de operarlo.
- **Lotes chicos, validación por etapa.** Un módulo a la vez. Cada etapa se
  comprueba antes de avanzar. Nada de corridas de 43 clases hasta que el flujo
  esté probado de punta a punta con el módulo 1.
- **La GPU trabaja.** ffmpeg con NVENC (Windows/RTX) o VideoToolbox (Mac) para
  el render pesado; CUDA confirmado (no "auto") para whisper.
- **Los originales jamás se tocan** (igual que v1).

## Cambios de motor (fase 1 — en curso)

### 1. Transcripción: worker persistente
`scripts/transcribe_faster.py` y `scripts/transcribe_mlx.py` ganan modo `--serve`:
cargan el modelo UNA vez y procesan una cola de clips vía JSONL por stdin/stdout.
`src/lib/transcribe/python-engine.ts` mantiene un solo proceso vivo por corrida.
En Windows el device es `cuda` explícito: si CUDA no está disponible **truena con
mensaje claro** en vez de degradar a CPU en silencio (`WHISPER_DEVICE` lo
sobreescribe a propósito). Meta: ~4 h de audio en 10–15 min, no 1 h.

### 2. Ensamblaje: backend `ffmpeg` (tercer backend)
`ASSEMBLY_BACKEND=ffmpeg` en `src/lib/assembly/ffmpeg/`. Un solo filtergraph por
clase: concat de tramos keep de los proxies + overlays PNG (`overlay` +
`enable=between(t,…)` + fades) + captions quemados vía ASS (libass, replicando el
estilo actual) + intro al frente. Encoder por detección: `h264_nvenc` →
`h264_videotoolbox` → `libx264` (fallback). Sin frames temporales en disco.
- Las **intros siguen siendo de Remotion** (5 s animadas, deterministas,
  cacheables): el backend ffmpeg delega `renderIntro` al backend remotion.
- `verify.ts` (conteo de frames) aplica igual — no le importa quién renderizó.
- Remotion queda como backend de respaldo y Palmier para retoque manual.

## Prueba piloto: módulo 1 de OVINOS (back-engineering)

Recrear desde cero el **Módulo 1 — Manejo diario del rebaño** (7 clases) con los
motores nuevos, partiendo del crudo. Los 10 clips fuente (mapeados desde el
`structure.json` final de la PC) viven en `material/MODULO1_OVINOS/`:

`IMG_0527, 0531, 0532, 0533, 0534, 0535, 0536, 0541, 0548, 0600` (~5.5 GB).

| Clase (según entrega v1) | Clips |
|---|---|
| 1.1 La rutina diaria al llegar al corral | 0527 |
| 1.2 Lectura de comederos | 0531 |
| 1.3 Inspección de los animales en el corral | 0532 |
| 1.4 Bebederos y suministro de agua | 0533, 0541, 0600 (B-roll) |
| 1.5 Revisión de corderos recién nacidos | 0534 |
| 1.6 La servida diaria de alimento | 0535, 0536 |
| 1.7 Manejos generales del rebaño | 0548 |

Esto además sirve de **ground truth**: el plan que arme la IA en v2 se puede
comparar contra esta tabla.

## Fases siguientes (en orden — NO adelantarse)

1. ✅ **Motores** (transcripción persistente + backend ffmpeg) — cerrada
   (commit `6016c58`; smoke 95/95 frames). Validación real pendiente en el piloto.
2. **Modo paso a paso + Frontend v2** — fase actual. Dos piezas:
   - **El pipeline deja de encadenarse solo.** El ingest corre solo hasta
     `sampled` (probe + transcripción + frames) y AHÍ SE DETIENE. Cada etapa
     posterior corre únicamente con su botón. El encadenado completo queda solo
     detrás de `run-all`/`AUTO_RUN` explícitos.
   - **Frontend v2**: wizard por pasos, bonito (skill `frontend-design`), estatus
     en tiempo real por etapa (progreso X/N, tiempos, gates), historial de jobs.
     Es la herramienta con la que el USUARIO opera el piloto — sin ella no hay
     fase 3.
3. **Piloto módulo 1 EN LA PC (`ssh itg`), operado por el usuario desde la UI.**
   El usuario sube `material/MODULO1_OVINOS.zip` desde el navegador
   (`https://itg.tailf75570.ts.net`), ve la transcripción avanzar en vivo,
   aprueba la estructura, y así etapa por etapa. Los agentes NO corren el flujo
   por él; asisten cuando algo falla. Aquí se validan CUDA `--serve`, NVENC y
   las divergencias visuales (issues `17m`, `acz`) y se miden tiempos vs v1.
4. **Storage**: migrar el estado de los `*.json` sueltos a **SQLite** (recomendado
   sobre MySQL/Postgres: cero servidor que administrar, un archivo por instalación,
   Drizzle/better-sqlite3, y sobra para este volumen). Los artefactos pesados
   (mp4, png, transcripts) siguen en disco; a la DB va estado, progreso, veredictos
   de QA y métricas de tiempo por etapa. Postgres solo si algún día hay multiusuario
   real concurrente.
5. **Escalar**: módulos 2–6 de OVINOS en lote, luego cursos completos.

## Reglas operativas

- Trabajo trackeado en `bd` (modo `real`). Épica del v2: buscar `flujo-v2` con
  `bd search`.
- Cada corrida de prueba registra **tiempos por etapa** (v1 vs v2) — es el KPI
  del proyecto: horas de niñera → corrida desatendida corta.
- La PC (`ssh itg`, `C:\FLUJO-AGROMAX`) es el entorno de producción (NVENC/CUDA);
  la Mac es desarrollo (VideoToolbox/MLX). Todo cambio de motor debe correr en ambos.

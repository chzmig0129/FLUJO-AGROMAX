/**
 * POST /api/ingest — recibe un ZIP de videos crudos y produce un job.
 *
 * Flujo: valida el multipart/form-data (zip), crea jobs/<id>/,
 * guarda el ZIP subido, extrae los videos a jobs/<id>/source/ (que queda
 * inmutable desde este punto en adelante — ver invariante en lib/jobs.ts),
 * borra el ZIP temporal, analiza los videos con ffprobe y persiste
 * job.json. El nombre del proyecto se deriva automáticamente del nombre
 * del archivo ZIP subido (sin extensión), sin input manual del usuario.
 * Cualquier error después de crear el directorio del job limpia
 * jobs/<id>/ por completo antes de responder.
 *
 * Server-only: corre en runtime Node.js (no Edge) porque usa fs, child_process
 * (ffprobe) y yauzl, ninguno de los cuales está disponible en el Edge runtime.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { createJobDir, jobPath, sourcePath, writeJobJson } from "@/lib/jobs";
import { extractVideosFromZip } from "@/lib/zip";
import { probeAll } from "@/lib/probe";
import { runPipeline } from "@/lib/pipeline";
import type { JobJson } from "@/lib/types";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json(
      { error: "No se pudo leer el formulario enviado" },
      { status: 400 }
    );
  }

  const zip = formData.get("zip");

  if (!(zip instanceof File)) {
    return NextResponse.json(
      { error: "Falta el archivo ZIP" },
      { status: 400 }
    );
  }

  // El nombre del proyecto se deriva del nombre del archivo ZIP subido.
  const name = path.basename(zip.name, path.extname(zip.name));

  const id = crypto.randomUUID();

  // A partir de aquí, cualquier error debe limpiar jobs/<id>/ antes de responder.
  try {
    await createJobDir(id);

    // Guardamos el ZIP subido temporalmente dentro del job para extraerlo.
    const uploadZipPath = path.join(jobPath(id), "upload.zip");
    const zipBuffer = Buffer.from(await zip.arrayBuffer());
    await fs.writeFile(uploadZipPath, zipBuffer);

    // Extraemos los videos a source/, que queda inmutable desde aquí en
    // adelante (ver invariante documentada en lib/jobs.ts).
    await extractVideosFromZip(uploadZipPath, sourcePath(id));

    // El ZIP subido no es parte del job final: solo era un paso intermedio.
    await fs.rm(uploadZipPath, { force: true });

    const files = await probeAll(sourcePath(id));

    const now = new Date().toISOString();
    const job: JobJson = {
      id,
      name,
      status: "ingested",
      stage: "ingest",
      createdAt: now,
      updatedAt: now,
      config: {},
      files,
    };
    await writeJobJson(job);

    // Arrancamos el pipeline (probe + transcripción) en background: no se
    // hace await para no bloquear la respuesta del ingest. Cualquier error
    // se loguea (el pipeline mismo ya persiste el estado 'error' en el job).
    runPipeline(id).catch(console.error);

    return NextResponse.json({ jobId: id, files });
  } catch (err) {
    // Limpiamos cualquier rastro del job a medio crear.
    await fs.rm(jobPath(id), { recursive: true, force: true });

    const message = err instanceof Error ? err.message : "Error inesperado procesando el ZIP";

    // Los errores conocidos de zip.ts vienen con mensajes en español y son
    // atribuibles al archivo subido por el usuario (400). Cualquier otro
    // error se trata como fallo interno (500).
    const isKnownZipError =
      message === "El archivo ZIP está corrupto o no se pudo leer" ||
      message === "El ZIP no contiene archivos de video";

    return NextResponse.json(
      { error: message },
      { status: isKnownZipError ? 400 : 500 }
    );
  }
}

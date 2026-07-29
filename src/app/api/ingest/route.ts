/**
 * POST /api/ingest — recibe un ZIP de videos crudos y produce un job.
 *
 * Flujo: valida el header 'x-filename', crea jobs/<id>/, streamea el body
 * RAW de la request directo a disco (jobs/<id>/upload.zip), extrae los
 * videos a jobs/<id>/source/ (que queda inmutable desde este punto en
 * adelante — ver invariante en lib/jobs.ts), borra el ZIP temporal, analiza
 * los videos con ffprobe y persiste job.json. El nombre del proyecto se
 * deriva automáticamente del nombre del archivo ZIP subido (sin extensión),
 * sin input manual del usuario. Cualquier error después de crear el
 * directorio del job limpia jobs/<id>/ por completo antes de responder.
 *
 * Contrato del body: RAW (no multipart/form-data). Se eligió así porque
 * request.formData() + file.arrayBuffer() carga el archivo completo en un
 * Buffer en memoria, y Buffer en Node tiene un límite (~2GB) además de ser
 * un desperdicio de RAM para archivos de decenas de GB. Streameando el
 * ReadableStream del body directo a un WriteStream con pipeline() la
 * memoria usada es constante sin importar el tamaño del ZIP. El nombre
 * original del archivo viaja en el header 'x-filename' (URL-encoded)
 * porque el body RAW no tiene metadata propia.
 *
 * Server-only: corre en runtime Node.js (no Edge) porque usa fs, child_process
 * (ffprobe) y yauzl, ninguno de los cuales está disponible en el Edge runtime.
 */
import { promises as fs, createWriteStream } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { NextResponse } from "next/server";
import { createJobDir, jobPath } from "@/lib/jobs";
import { ingestFromLocalZip, isKnownZipError } from "@/lib/ingest";

export const runtime = "nodejs";

export async function POST(request: Request): Promise<NextResponse> {
  const rawFilename = request.headers.get("x-filename");
  if (!rawFilename) {
    return NextResponse.json(
      { error: "Falta el header x-filename" },
      { status: 400 }
    );
  }

  let filename: string;
  try {
    filename = decodeURIComponent(rawFilename);
  } catch {
    return NextResponse.json(
      { error: "El header x-filename no es válido" },
      { status: 400 }
    );
  }

  if (!filename.toLowerCase().endsWith(".zip")) {
    return NextResponse.json(
      { error: "El archivo debe ser un ZIP" },
      { status: 400 }
    );
  }

  if (!request.body) {
    return NextResponse.json(
      { error: "Falta el archivo ZIP" },
      { status: 400 }
    );
  }

  // El nombre del proyecto se deriva del nombre del archivo ZIP subido.
  const name = path.basename(filename, path.extname(filename));

  const id = crypto.randomUUID();

  // A partir de aquí, cualquier error debe limpiar jobs/<id>/ antes de responder.
  try {
    await createJobDir(id);

    // Guardamos el ZIP subido temporalmente dentro del job para extraerlo.
    // Streameamos el body web (ReadableStream) directo a disco con memoria
    // constante — ver comentario del contrato arriba.
    const uploadZipPath = path.join(jobPath(id), "upload.zip");
    await pipeline(
      Readable.fromWeb(request.body as import("node:stream/web").ReadableStream),
      createWriteStream(uploadZipPath)
    );

    const { files } = await ingestFromLocalZip(id, name, uploadZipPath);

    return NextResponse.json({ jobId: id, files });
  } catch (err) {
    // Logueamos el error completo a consola: si el cliente ya se fue (p.ej.
    // un upload grande cortado a mitad de camino), esta es la única forma de
    // no perder la causa del fallo (Next no puede reenviarla al cliente).
    console.error(
      "Error en POST /api/ingest:",
      err instanceof Error ? err.stack ?? err.message : err
    );

    // Limpiamos cualquier rastro del job a medio crear.
    await fs.rm(jobPath(id), { recursive: true, force: true });

    const message = err instanceof Error ? err.message : "Error inesperado procesando el ZIP";

    // Los errores conocidos de zip.ts vienen con mensajes en español y son
    // atribuibles al archivo subido por el usuario (400). Cualquier otro
    // error se trata como fallo interno (500).
    return NextResponse.json(
      { error: message },
      { status: isKnownZipError(message) ? 400 : 500 }
    );
  }
}

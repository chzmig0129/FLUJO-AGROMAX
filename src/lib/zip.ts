import fs from "fs";
import path from "path";
import yauzl from "yauzl";

// Extensiones de video soportadas (case-insensitive)
const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".mov",
  ".m4v",
  ".avi",
  ".mkv",
  ".webm",
  ".mts",
  ".m2ts",
  ".3gp",
  ".wmv",
  ".mpg",
  ".mpeg",
]);

/**
 * Determina si un nombre de entrada del ZIP tiene extensión de video.
 */
function isVideoExtension(entryName: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(entryName).toLowerCase());
}

/**
 * Determina si una entrada debe ignorarse: directorios, metadata de macOS
 * (__MACOSX/), .DS_Store, y cualquier archivo cuyo basename empiece con '.'.
 */
function shouldSkipEntry(entryName: string): boolean {
  // Directorios: yauzl los marca con '/' al final
  if (entryName.endsWith("/")) return true;

  // Carpeta de metadata de macOS
  if (entryName.startsWith("__MACOSX/") || entryName.includes("/__MACOSX/")) {
    return true;
  }

  const base = path.basename(entryName);

  // Archivos ocultos / basura de macOS (.DS_Store, .archivo, etc.)
  if (base.startsWith(".")) return true;

  return false;
}

/**
 * Dado un basename ya usado, genera un nombre alternativo agregando un
 * sufijo " (2)", " (3)", ... antes de la extensión, evitando colisiones
 * con nombres ya usados en el set `usedNames`.
 */
function resolveCollision(baseName: string, usedNames: Set<string>): string {
  if (!usedNames.has(baseName)) return baseName;

  const ext = path.extname(baseName);
  const stem = baseName.slice(0, baseName.length - ext.length);

  let counter = 2;
  let candidate = `${stem} (${counter})${ext}`;
  while (usedNames.has(candidate)) {
    counter += 1;
    candidate = `${stem} (${counter})${ext}`;
  }
  return candidate;
}

/**
 * Extrae únicamente los archivos de video contenidos en un ZIP hacia
 * `destDir`, de forma PLANA (sin recrear subcarpetas).
 *
 * Nota de seguridad (zip-slip): normalmente un ZIP-slip explota rutas de
 * entrada tipo "../../etc/passwd" para escribir fuera de destDir. Acá
 * usamos SIEMPRE path.basename(entry.fileName) como nombre de destino, lo
 * que descarta por completo cualquier componente de directorio (incluido
 * "..") de la ruta original. Por lo tanto, aunque el ZIP venga con rutas
 * maliciosas, el archivo resultante siempre se escribe directamente dentro
 * de destDir y nunca puede "escapar" de él.
 */
export function extractVideosFromZip(
  zipPath: string,
  destDir: string
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (openErr, zipfile) => {
      if (openErr || !zipfile) {
        reject(
          new Error("El archivo ZIP está corrupto o no se pudo leer")
        );
        return;
      }

      const extractedNames: string[] = [];
      const usedNames = new Set<string>();
      let settled = false;

      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        zipfile.close();
        if (err) {
          reject(err);
          return;
        }
        if (extractedNames.length === 0) {
          reject(new Error("El ZIP no contiene archivos de video"));
          return;
        }
        resolve(extractedNames);
      };

      zipfile.on("error", () => {
        finish(new Error("El archivo ZIP está corrupto o no se pudo leer"));
      });

      zipfile.on("end", () => {
        finish();
      });

      zipfile.on("entry", (entry: yauzl.Entry) => {
        if (shouldSkipEntry(entry.fileName) || !isVideoExtension(entry.fileName)) {
          zipfile.readEntry();
          return;
        }

        // Aplanamos la ruta usando solo el basename (ver nota de zip-slip arriba)
        const targetName = resolveCollision(
          path.basename(entry.fileName),
          usedNames
        );

        zipfile.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) {
            finish(new Error("El archivo ZIP está corrupto o no se pudo leer"));
            return;
          }

          const targetPath = path.join(destDir, targetName);
          const writeStream = fs.createWriteStream(targetPath);

          readStream.on("error", () => {
            finish(new Error("El archivo ZIP está corrupto o no se pudo leer"));
          });

          writeStream.on("error", () => {
            finish(new Error("El archivo ZIP está corrupto o no se pudo leer"));
          });

          writeStream.on("close", () => {
            usedNames.add(targetName);
            extractedNames.push(targetName);
            zipfile.readEntry();
          });

          readStream.pipe(writeStream);
        });
      });

      zipfile.readEntry();
    });
  });
}

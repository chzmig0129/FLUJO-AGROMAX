"use client";

/**
 * StructureEditor — modo edición del gate humano de estructura (paso 3 del
 * wizard). Misma funcionalidad que la UI v1: renombrar módulos/clases,
 * reordenar clases dentro de su módulo, moverlas entre módulos, editar el
 * JSON completo y guardar (el PUT invalida la aprobación previa en el
 * servidor). El estado vive en la página; esto es presentación + callbacks.
 */
import type { StructureJson } from "@/lib/types";
import { formatTimestamp } from "./format";

export function StructureEditor({
  value,
  jsonText,
  jsonError,
  saving,
  saveError,
  onModuleTitleChange,
  onLessonTitleChange,
  onReorderLesson,
  onMoveLessonToModule,
  onJsonTextChange,
  onApplyJson,
  onSave,
  onCancel,
}: {
  value: StructureJson;
  jsonText: string;
  jsonError: string | null;
  saving: boolean;
  saveError: string | null;
  onModuleTitleChange: (moduleId: string, title: string) => void;
  onLessonTitleChange: (
    moduleId: string,
    lessonId: string,
    title: string
  ) => void;
  onReorderLesson: (
    moduleId: string,
    lessonId: string,
    direction: -1 | 1
  ) => void;
  onMoveLessonToModule: (
    fromModuleId: string,
    lessonId: string,
    toModuleId: string
  ) => void;
  onJsonTextChange: (text: string) => void;
  onApplyJson: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const sortedModules = value.modules.slice().sort((a, b) => a.order - b.order);

  return (
    <>
      <div className="structure-tree">
        {sortedModules.map((mod) => (
          <div className="structure-module" key={mod.id}>
            <div className="field">
              <label htmlFor={`mod-title-${mod.id}`}>Módulo</label>
              <input
                id={`mod-title-${mod.id}`}
                className="input"
                type="text"
                value={mod.title}
                onChange={(e) => onModuleTitleChange(mod.id, e.target.value)}
              />
            </div>
            {mod.topics.length > 0 && (
              <p className="structure-module-topics">
                {mod.topics.join(" · ")}
              </p>
            )}
            <ul className="structure-lesson-list">
              {mod.lessons
                .slice()
                .sort((a, b) => a.order - b.order)
                .map((lesson, idx, sortedLessons) => (
                  <li className="structure-lesson" key={lesson.id}>
                    <div className="field">
                      <label htmlFor={`lesson-title-${lesson.id}`}>Clase</label>
                      <input
                        id={`lesson-title-${lesson.id}`}
                        className="input"
                        type="text"
                        value={lesson.title}
                        onChange={(e) =>
                          onLessonTitleChange(mod.id, lesson.id, e.target.value)
                        }
                      />
                    </div>
                    <div className="row">
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => onReorderLesson(mod.id, lesson.id, -1)}
                        disabled={idx === 0}
                        aria-label="Subir clase"
                      >
                        ↑
                      </button>
                      <button
                        className="btn btn-secondary"
                        type="button"
                        onClick={() => onReorderLesson(mod.id, lesson.id, 1)}
                        disabled={idx === sortedLessons.length - 1}
                        aria-label="Bajar clase"
                      >
                        ↓
                      </button>
                      <select
                        className="select"
                        value={mod.id}
                        onChange={(e) =>
                          onMoveLessonToModule(mod.id, lesson.id, e.target.value)
                        }
                        aria-label="Mover clase a otro módulo"
                      >
                        {sortedModules.map((m2) => (
                          <option key={m2.id} value={m2.id}>
                            {m2.title}
                          </option>
                        ))}
                      </select>
                    </div>
                    <ul className="structure-segment-list">
                      {lesson.segments.map((seg, idx2) => (
                        <li
                          className="structure-segment"
                          key={`${seg.clip}-${idx2}`}
                        >
                          <span className="badge">{seg.clip}</span>{" "}
                          <span className="structure-segment-range">
                            {formatTimestamp(seg.startSeconds)}–
                            {formatTimestamp(seg.endSeconds)}
                          </span>{" "}
                          <span className="structure-segment-topic">
                            {seg.topic}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
            </ul>
          </div>
        ))}
      </div>

      <details className="decisiones-details">
        <summary>Editar JSON completo</summary>
        <textarea
          className="input"
          rows={20}
          value={jsonText}
          onChange={(e) => onJsonTextChange(e.target.value)}
        />
        <div className="stepper-actions">
          <button
            className="btn btn-secondary"
            type="button"
            onClick={onApplyJson}
          >
            Aplicar JSON
          </button>
        </div>
        {jsonError && <p className="stepper-error-msg">{jsonError}</p>}
      </details>

      <div className="stepper-actions">
        <button className="btn" type="button" onClick={onSave} disabled={saving}>
          {saving ? "Guardando…" : "Guardar cambios"}
        </button>
        <button
          className="btn btn-secondary"
          type="button"
          onClick={onCancel}
          disabled={saving}
        >
          Cancelar
        </button>
      </div>
      {saveError && <p className="stepper-error-msg">{saveError}</p>}
    </>
  );
}

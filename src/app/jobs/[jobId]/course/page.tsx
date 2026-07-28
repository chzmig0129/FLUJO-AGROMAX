import "server-only";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  readJobJson,
  readPackageManifest,
  readRenderSidecars,
  readStructureJson,
} from "@/lib/jobs";
import type { RenderSidecar, StructureJson } from "@/lib/types";
import styles from "./course.module.css";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type CoursePageProps = {
  params: Promise<{ jobId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

type StructureModule = StructureJson["modules"][number];
type StructureLesson = StructureModule["lessons"][number];

type AvailableLesson = {
  module: StructureModule;
  lesson: StructureLesson;
  sidecar: RenderSidecar;
  position: number;
};

type AvailableModule = {
  module: StructureModule;
  lessons: AvailableLesson[];
};

type LoadedCourseData = [
  Awaited<ReturnType<typeof readJobJson>>,
  Awaited<ReturnType<typeof readStructureJson>>,
  Awaited<ReturnType<typeof readPackageManifest>>,
  Awaited<ReturnType<typeof readRenderSidecars>>,
];

function uniqueTopics(topics: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];

  for (const topic of topics) {
    const trimmed = topic.trim();
    const key = trimmed.replace(/\s+/g, " ").toLocaleLowerCase("es");
    if (!trimmed || seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }

  return unique;
}

function isBrollTopic(topic: string): boolean {
  return /^b[\s-]?roll\s*:/i.test(topic);
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";

  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(
      remainingSeconds
    ).padStart(2, "0")}`;
  }

  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function lessonHref(jobId: string, lessonId: string): string {
  return `/jobs/${encodeURIComponent(jobId)}/course?lesson=${encodeURIComponent(
    lessonId
  )}`;
}

export default async function CoursePage({
  params,
  searchParams,
}: CoursePageProps) {
  const [{ jobId }, query] = await Promise.all([params, searchParams]);

  let loaded: LoadedCourseData;

  try {
    loaded = await Promise.all([
      readJobJson(jobId),
      readStructureJson(jobId),
      readPackageManifest(jobId),
      readRenderSidecars(jobId),
    ]);
  } catch {
    notFound();
  }

  const [, structure, packageManifest, renderSidecars] = loaded;
  if (!structure || !packageManifest) notFound();

  const sidecarsByLesson = new Map(
    renderSidecars.map((sidecar) => [sidecar.lessonId, sidecar])
  );
  const packagedByLesson = new Map(
    packageManifest.lessons.map((lesson) => [lesson.lessonId, lesson])
  );
  const includedLessonIds = new Set<string>();
  const availableModules: AvailableModule[] = [];
  const allLessons: AvailableLesson[] = [];

  for (const moduleEntry of [...structure.modules].sort(
    (a, b) => a.order - b.order
  )) {
    const availableLessons: AvailableLesson[] = [];

    for (const lesson of [...moduleEntry.lessons].sort(
      (a, b) => a.order - b.order
    )) {
      const packaged = packagedByLesson.get(lesson.id);
      const sidecar = sidecarsByLesson.get(lesson.id);

      if (
        !packaged ||
        packaged.moduleId !== moduleEntry.id ||
        !sidecar ||
        sidecar.status !== "complete" ||
        includedLessonIds.has(lesson.id)
      ) {
        continue;
      }

      includedLessonIds.add(lesson.id);
      const availableLesson: AvailableLesson = {
        module: moduleEntry,
        lesson,
        sidecar,
        position: allLessons.length,
      };
      availableLessons.push(availableLesson);
      allLessons.push(availableLesson);
    }

    if (availableLessons.length > 0) {
      availableModules.push({
        module: moduleEntry,
        lessons: availableLessons,
      });
    }
  }

  if (allLessons.length === 0) notFound();

  const requestedLessonId = query.lesson;
  if (requestedLessonId === undefined) {
    redirect(lessonHref(jobId, allLessons[0].lesson.id));
  }
  if (typeof requestedLessonId !== "string" || requestedLessonId.length === 0) {
    notFound();
  }

  const current = allLessons.find(
    ({ lesson }) => lesson.id === requestedLessonId
  );
  if (!current) notFound();

  const previous = allLessons[current.position - 1];
  const next = allLessons[current.position + 1];
  const lessonTopics = uniqueTopics(
    current.lesson.segments.map((segment) => segment.topic)
  );
  const contentTopics = lessonTopics.filter((topic) => !isBrollTopic(topic));
  const brollTopics = lessonTopics.filter(isBrollTopic);
  const moduleTopics = uniqueTopics(current.module.topics);
  const videoUrl = `/api/jobs/${encodeURIComponent(
    jobId
  )}/render/${encodeURIComponent(current.lesson.id)}.mp4`;

  return (
    <main className={styles.page}>
      <div className={styles.topbar}>
        <Link
          className={styles.backLink}
          href={`/jobs/${encodeURIComponent(jobId)}`}
        >
          <span aria-hidden="true">←</span> Volver a la entrega
        </Link>
        <p className={styles.courseEyebrow}>Curso</p>
        <h1>{structure.courseTitle}</h1>
      </div>

      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <div className={styles.sidebarHeading}>
            <span>Contenido</span>
            <span>{allLessons.length} clases</span>
          </div>

          <nav aria-label="Clases del curso" className={styles.moduleNav}>
            {availableModules.map(({ module: moduleEntry, lessons }) => {
              const isActiveModule = moduleEntry.id === current.module.id;

              return (
                <details
                  className={styles.module}
                  key={moduleEntry.id}
                  open={isActiveModule}
                >
                  <summary className={styles.moduleSummary}>
                    <span className={styles.moduleOrdinal}>
                      Módulo {moduleEntry.order}
                    </span>
                    <span className={styles.moduleTitle}>
                      {moduleEntry.title}
                    </span>
                    <span className={styles.moduleCount}>
                      {lessons.length} {lessons.length === 1 ? "clase" : "clases"}
                    </span>
                  </summary>

                  <ol className={styles.lessonList}>
                    {lessons.map((item) => {
                      const isActive = item.lesson.id === current.lesson.id;

                      return (
                        <li key={item.lesson.id}>
                          <Link
                            aria-current={isActive ? "page" : undefined}
                            className={`${styles.lessonLink} ${
                              isActive ? styles.activeLesson : ""
                            }`}
                            href={lessonHref(jobId, item.lesson.id)}
                          >
                            <span className={styles.lessonOrdinal}>
                              {moduleEntry.order}.{item.lesson.order}
                            </span>
                            <span className={styles.lessonNavTitle}>
                              {item.lesson.title}
                            </span>
                            <span className={styles.lessonDuration}>
                              {formatDuration(item.sidecar.durationSeconds)}
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ol>
                </details>
              );
            })}
          </nav>
        </aside>

        <article className={styles.lesson}>
          <div className={styles.videoFrame}>
            <video
              key={current.lesson.id}
              className={styles.video}
              controls
              playsInline
              preload="metadata"
              src={videoUrl}
            >
              Tu navegador no puede reproducir este video.
            </video>
          </div>

          <header className={styles.lessonHeader}>
            <div className={styles.lessonMeta}>
              <span>
                Módulo {current.module.order} · Clase {current.lesson.order}
              </span>
              <span aria-hidden="true">·</span>
              <span>{formatDuration(current.sidecar.durationSeconds)}</span>
            </div>
            <h2>{current.lesson.title}</h2>
            <p className={styles.moduleName}>{current.module.title}</p>
          </header>

          {(contentTopics.length > 0 || brollTopics.length > 0) && (
            <section className={styles.topicSection} aria-labelledby="lesson-topics">
              <h3 id="lesson-topics">Temas de la clase</h3>
              {contentTopics.length > 0 && (
                <ul className={styles.topicList}>
                  {contentTopics.map((topic) => (
                    <li key={topic}>{topic}</li>
                  ))}
                </ul>
              )}
              {brollTopics.length > 0 && (
                <div className={styles.broll}>
                  <h4>Apoyo visual</h4>
                  <ul>
                    {brollTopics.map((topic) => (
                      <li key={topic}>{topic}</li>
                    ))}
                  </ul>
                </div>
              )}
            </section>
          )}

          {moduleTopics.length > 0 && (
            <section className={styles.moduleTopics} aria-labelledby="module-topics">
              <h3 id="module-topics">Temas del módulo</h3>
              <ul>
                {moduleTopics.map((topic) => (
                  <li key={topic}>{topic}</li>
                ))}
              </ul>
            </section>
          )}

          <nav className={styles.pager} aria-label="Navegación entre clases">
            {previous ? (
              <Link
                className={styles.pagerLink}
                href={lessonHref(jobId, previous.lesson.id)}
                rel="prev"
              >
                <span className={styles.pagerDirection}>← Clase anterior</span>
                <span>{previous.lesson.title}</span>
              </Link>
            ) : (
              <span
                aria-disabled="true"
                className={`${styles.pagerLink} ${styles.disabledPager}`}
              >
                <span className={styles.pagerDirection}>← Clase anterior</span>
                <span>Inicio del curso</span>
              </span>
            )}

            {next ? (
              <Link
                className={`${styles.pagerLink} ${styles.nextLink}`}
                href={lessonHref(jobId, next.lesson.id)}
                rel="next"
              >
                <span className={styles.pagerDirection}>Siguiente clase →</span>
                <span>{next.lesson.title}</span>
              </Link>
            ) : (
              <span
                aria-disabled="true"
                className={`${styles.pagerLink} ${styles.nextLink} ${styles.disabledPager}`}
              >
                <span className={styles.pagerDirection}>Siguiente clase →</span>
                <span>Fin del curso</span>
              </span>
            )}
          </nav>
        </article>
      </div>
    </main>
  );
}

/**
 * index.ts — entrypoint del bundle de Remotion. Es el archivo que
 * src/lib/assembly/remotion/backend.ts empaqueta con @remotion/bundler.
 */
import { registerRoot } from "remotion";
import { RemotionRoot } from "./Root";

registerRoot(RemotionRoot);

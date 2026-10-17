import type * as THREE from "three";

/** Borrow renderer clear policy for one background/worlds frame, then restore it. */
export function backgroundRenderHooks(renderer: THREE.WebGLRenderer, render: () => void) {
  let previousAutoClear = renderer.autoClear;
  let rendering = false;
  const restore = () => {
    if (!rendering) return;
    renderer.autoClear = previousAutoClear; rendering = false;
  };
  return {
    beforeRender() {
      previousAutoClear = renderer.autoClear; rendering = true;
      try {
        if (previousAutoClear) renderer.clear(true, true, true);
        renderer.autoClear = false;
        render(); renderer.clearDepth();
      } catch (error) { restore(); throw error; }
    },
    afterRender: restore,
    dispose: restore,
  };
}

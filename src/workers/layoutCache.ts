}

/** Shared singleton, created lazily so importing the module is side-effect free. */
let shared: LayoutCache | null = null;

export function getLayoutCache(seed?: number): LayoutCache {
  if (!shared) shared = new LayoutCache(seed);
  else if (seed !== undefined) shared.seed = seed;
  return shared;
}



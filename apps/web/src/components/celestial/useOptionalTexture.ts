import { useEffect, useState } from "react";
import { SRGBColorSpace, type Texture, TextureLoader } from "three";

/**
 * Loads a texture that may legitimately be absent (planet textures are fetched by an explicit
 * script, not shipped in Git). Returns null while loading or if the file is missing, so callers
 * render an untextured fallback instead of crashing.
 */
export function useOptionalTexture(url: string): Texture | null {
  const [texture, setTexture] = useState<Texture | null>(null);
  useEffect(() => {
    let alive = true;
    let loaded: Texture | null = null;
    new TextureLoader().load(
      url,
      (t) => {
        if (!alive) return t.dispose();
        t.colorSpace = SRGBColorSpace;
        t.anisotropy = 8;
        loaded = t;
        setTexture(t);
      },
      undefined,
      () => alive && setTexture(null),
    );
    return () => {
      alive = false;
      loaded?.dispose();
    };
  }, [url]);
  return texture;
}

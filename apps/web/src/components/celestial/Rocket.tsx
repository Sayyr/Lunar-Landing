// Rocket model (public/models/rocket.glb) placed on the computed trajectory. VISUALIZATION ONLY:
// drawn at a fixed on-screen size (not to scale) and oriented from the trajectory geometry —
// nose along the velocity during the transfer, nose away from the Moon (engine toward the surface)
// during the powered descent. Falls back to a small sphere if the model cannot be loaded.
import { useEffect, useMemo, useState } from "react";
import { Box3, Group, Quaternion, Vector3 } from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

export const ROCKET_URL = `${import.meta.env.BASE_URL}models/rocket.glb`;

let cached: Promise<Group | null> | null = null;
/** Loads the model once; null when it is missing or unreadable. */
function loadRocket(): Promise<Group | null> {
  cached ??= new GLTFLoader()
    .loadAsync(ROCKET_URL)
    .then((g) => {
      // Normalise: centred on the origin, nose along +Y (the model's own axis), largest side 1.
      const box = new Box3().setFromObject(g.scene);
      const size = box.getSize(new Vector3());
      const centre = box.getCenter(new Vector3());
      g.scene.position.set(-centre.x, -centre.y, -centre.z);
      const wrap = new Group();
      wrap.add(g.scene);
      wrap.scale.setScalar(1 / Math.max(size.x, size.y, size.z));
      return wrap;
    })
    .catch(() => null);
  return cached;
}

const UP = new Vector3(0, 1, 0);

/** Quaternion turning the model's +Y onto `dir` (three.js world axes). */
export function noseQuaternion(dir: readonly [number, number, number]): [number, number, number, number] {
  const d = new Vector3(dir[0], dir[1], dir[2]);
  if (d.lengthSq() === 0) return [0, 0, 0, 1];
  const q = new Quaternion().setFromUnitVectors(UP, d.normalize());
  return [q.x, q.y, q.z, q.w];
}

export function Rocket({
  position,
  nose,
  length,
  colour,
  anchor = "centre",
}: {
  position: [number, number, number];
  /** "base": `position` is the engine end (rocket standing on a surface); "centre": the middle */
  anchor?: "centre" | "base";
  /** direction of the nose, three.js world axes */
  nose: [number, number, number];
  /** drawn length, scene units */
  length: number;
  /** fallback sphere colour */
  colour: string;
}) {
  const [model, setModel] = useState<Group | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void loadRocket().then((m) => live && setModel(m));
    return () => {
      live = false;
    };
  }, []);
  // One clone per mounted rocket (the cached template is never added to a scene).
  const instance = useMemo(() => (model ? model.clone(true) : null), [model]);
  const q = noseQuaternion(nose);
  if (!instance)
    return (
      <mesh position={position}>
        <sphereGeometry args={[0.35, 12, 12]} />
        <meshBasicMaterial color={colour} />
      </mesh>
    );
  return (
    <group position={position} quaternion={q} scale={length}>
      <group position={[0, anchor === "base" ? 0.5 : 0, 0]}>
        <primitive object={instance} />
      </group>
    </group>
  );
}

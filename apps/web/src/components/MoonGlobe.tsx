import { Line, OrbitControls } from "@react-three/drei";
import { Canvas, type ThreeEvent } from "@react-three/fiber";
import { useMemo } from "react";

import { displayToLatLon, latLonToDisplay } from "../lib/coords";

interface Props {
  latitudeDeg: number;
  longitudeDeg: number;
  onPick: (latitudeDeg: number, longitudeDeg: number) => void;
}

const GRID_STEP_DEG = 15;

function graticule(): [number, number, number][][] {
  const lines: [number, number, number][][] = [];
  for (let lat = -75; lat <= 75; lat += GRID_STEP_DEG) {
    const ring: [number, number, number][] = [];
    for (let lon = -180; lon <= 180; lon += 3) ring.push(latLonToDisplay(lat, lon, 1.002));
    lines.push(ring);
  }
  for (let lon = -180; lon < 180; lon += GRID_STEP_DEG) {
    const meridian: [number, number, number][] = [];
    for (let lat = -90; lat <= 90; lat += 3) meridian.push(latLonToDisplay(lat, lon, 1.002));
    lines.push(meridian);
  }
  return lines;
}

function Moon({ latitudeDeg, longitudeDeg, onPick }: Props) {
  const lines = useMemo(graticule, []);
  const primeMeridian = useMemo(
    () => Array.from({ length: 61 }, (_, i) => latLonToDisplay(-90 + i * 3, 0, 1.004)),
    [],
  );
  const marker = latLonToDisplay(latitudeDeg, longitudeDeg, 1.01);

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.delta > 4) return; // a drag to rotate, not a pick
    e.stopPropagation();
    const p = displayToLatLon(e.point.x, e.point.y, e.point.z);
    onPick(+p.latitude_deg.toFixed(3), +p.longitude_deg.toFixed(3));
  };

  return (
    <group>
      <mesh onClick={handleClick}>
        <sphereGeometry args={[1, 96, 64]} />
        <meshStandardMaterial color="#8d8d8d" roughness={1} />
      </mesh>
      {lines.map((pts, i) => (
        <Line key={i} points={pts} color="#3c4250" lineWidth={0.6} transparent opacity={0.7} />
      ))}
      <Line points={primeMeridian} color="#d9a441" lineWidth={1.4} />
      <mesh position={latLonToDisplay(-90, 0, 1.003)}>
        <sphereGeometry args={[0.012, 12, 12]} />
        <meshBasicMaterial color="#7fb3ff" />
      </mesh>
      <mesh position={marker}>
        <sphereGeometry args={[0.022, 16, 16]} />
        <meshBasicMaterial color="#ff5a5f" />
      </mesh>
    </group>
  );
}

export function MoonGlobe(props: Props) {
  return (
    <div className="globe">
      {/* Start looking at the south polar region. */}
      <Canvas camera={{ position: [0, -2.2, 2.0], fov: 45 }}>
        <ambientLight intensity={0.55} />
        {/* Decorative lighting only — NOT the computed Sun direction. */}
        <directionalLight position={[3, 1, 2]} intensity={1.6} />
        <Moon {...props} />
        <OrbitControls enablePan={false} minDistance={1.4} maxDistance={6} />
      </Canvas>
      <p className="caption">
        Visualization only: untextured sphere, {GRID_STEP_DEG}° graticule, <span className="gold">prime meridian</span>,{" "}
        <span className="blue">south pole</span>, <span className="red">selected site</span>. Lighting is decorative and
        does not show the computed Sun direction. Click to pick a site; drag to rotate.
      </p>
    </div>
  );
}

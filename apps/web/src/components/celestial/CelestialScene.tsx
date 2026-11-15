import { Html, Line, OrbitControls } from "@react-three/drei";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { memo, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { type Matrix4, type PerspectiveCamera, type Texture } from "three";

import { getCelestialTracks } from "../../api/celestial";
import type { CelestialStateResponse, CelestialTracksResponse } from "../../api/celestialTypes";
import type { TrajectoryResponse } from "../../api/trajectoryTypes";
import { positionAt, type TrajectoryPoint } from "../../lib/trajectory";
import { AU_M, EARTH_MEAN_RADIUS_M, MOON_RADIUS_KM, SUN_RADIUS_M } from "../../lib/constants";
import { bodyRotationToThree, closeLoop, eclToThree, normalize, type V3 } from "../../lib/sceneFrame";
import { disposeStarField, makeStarField } from "../../lib/stars";
import { DATA_BASE, SETUP_HINT } from "../../lunar/loaders";
import { Earth, Moon, Sun } from "./Bodies";
import { useOptionalTexture } from "./useOptionalTexture";

export type SceneView = "earth-moon" | "solar";

const DAY_MS = 86_400_000;
const MEAN_MOON_DIST_M = 384_400_000;

// Schematic (solar) view: compressed distances, exaggerated radii — directions are preserved.
const SOLAR = { sunRadius: 5, earthOrbit: 55, earthRadius: 1.4, moonDist: 7, moonRadius: 0.45 };
// Earth–Moon view: 1 unit = 1 Earth radius. Sun drawn at a compressed distance with its TRUE angular size.
const SUN_PROXY_DIST = 400;
/** Optional radius exaggeration for Earth and Moon in the Earth–Moon view (distances stay true). */
export const BODY_ENLARGEMENT = 6;

interface Props {
  state: CelestialStateResponse;
  view: SceneView;
  /** Earth–Moon view only: multiply Earth and Moon radii by BODY_ENLARGEMENT. */
  enlargeBodies: boolean;
  /** false while the tab is hidden: the render loop is paused. */
  active: boolean;
  /** km per pixel at the orbit target (Earth–Moon view); null in the schematic view. Must be stable. */
  onScale?: (kmPerPx: number | null) => void;
  footnote?: ReactNode;
  offsetX?: number;
  /** computed Earth→Moon trajectory (vecteur-traj), drawn in the Earth–Moon view */
  trajectory?: { response: TrajectoryResponse; points: TrajectoryPoint[] } | null;
  /** SPICE Moon at the trajectory's arrival (ECLIPJ2000 m), drawn as a ghost before that instant */
  arrivalMoon?: { utc: string; position_m: number[] } | null;
}

/**
 * Reports km per pixel at the orbit target (the Earth's centre), Earth–Moon view only.
 * Reported when it changes by more than 1 %, so React does not re-render every frame.
 */
function ScaleProbe({ onScale }: { onScale: (kmPerPx: number) => void }) {
  const last = useRef(0);
  useFrame(({ camera, size }) => {
    const cam = camera as PerspectiveCamera;
    const unitsPerPx = (2 * cam.position.length() * Math.tan(((cam.fov / 2) * Math.PI) / 180)) / size.height;
    const k = (unitsPerPx * EARTH_MEAN_RADIUS_M) / 1000; // 1 unit = 1 Earth radius
    if (Math.abs(k / (last.current || 1) - 1) > 0.01) {
      last.current = k;
      onScale(k);
    }
  });
  return null;
}

interface ViewProps {
  state: CelestialStateResponse;
  earthTex: Texture | null;
  moonTex: Texture | null;
  earthOrientation: Matrix4;
  moonOrientation: Matrix4;
  /** orbit traces from the API, fetched once per UTC day (null while loading or unavailable) */
  tracks: CelestialTracksResponse | null;
  trajectory?: Props["trajectory"];
  arrivalMoon?: Props["arrivalMoon"];
}

const SEGMENT_COLOUR = { transfer: "#3ddbd9", descent: "#ff8c42" } as const;

/** Computed transfer + descent (geocentric, true scale) and the spacecraft at the scene's instant. */
function TrajectoryPath({
  trajectory,
  utc,
  scale,
  arrivalMoon,
  moonRadius,
}: {
  trajectory: NonNullable<Props["trajectory"]>;
  utc: string;
  scale: number;
  arrivalMoon?: Props["arrivalMoon"];
  moonRadius: number;
}) {
  const lines = useMemo(
    () => trajectory.response.segments.map((seg) => ({ phase: seg.phase, pts: scaleTrack(seg.positions_m, scale) })),
    [trajectory, scale],
  );
  const craft = positionAt(trajectory.points, Date.parse(utc));
  const craftPos = craft ? eclToThree(craft.p, scale) : null;
  // Before the arrival the real Moon is elsewhere on its orbit: show where it will be.
  const ghost = arrivalMoon && Date.parse(utc) < Date.parse(arrivalMoon.utc) - 1_800_000 ? eclToThree(arrivalMoon.position_m, scale) : null;
  return (
    <group>
      {ghost && (
        <mesh position={ghost}>
          <sphereGeometry args={[moonRadius, 32, 16]} />
          <meshBasicMaterial color="#9aa3b5" wireframe transparent opacity={0.35} />
          <Html center className="axis-label" position={[0, moonRadius + 1.2, 0]}>
            Moon at arrival ({arrivalMoon!.utc.slice(5, 16).replace("T", " ")} UTC)
          </Html>
        </mesh>
      )}
      {lines.map((l) => l.pts.length > 1 && <Line key={l.phase} points={l.pts} color={SEGMENT_COLOUR[l.phase]} lineWidth={2} />)}
      {craftPos && (
        <mesh position={craftPos}>
          <sphereGeometry args={[0.35, 12, 12]} />
          <meshBasicMaterial color={SEGMENT_COLOUR[craft!.phase]} />
          <Html center className="axis-label" position={[0, 1.2, 0]}>
            spacecraft ({craft!.phase})
          </Html>
        </mesh>
      )}
    </group>
  );
}

const scaleTrack = (points: V3[], scale: number): V3[] => points.map((p) => eclToThree(p, scale));
const times = (v: V3, k: number): V3 => [v[0] * k, v[1] * k, v[2] * k];

// memo: props are constant per view, so play-mode ticks don't rebuild the dashed γ line.
const EclipticFrameHints = memo(function EclipticFrameHints({ radius }: { radius: number }) {
  return (
    <group>
      <polarGridHelper args={[radius, 12, 4, 96, "#2a3242", "#1c2230"]} />
      <Line points={[[0, 0, 0], [radius * 1.08, 0, 0]]} color="#6b7894" lineWidth={1} dashed dashSize={1.5} gapSize={1} />
      <Html position={[radius * 1.12, 0, 0]} center className="axis-label">
        γ equinox J2000
      </Html>
    </group>
  );
});

function EarthMoonView({ state, earthTex, moonTex, earthOrientation, moonOrientation, tracks, trajectory, arrivalMoon, bodyScale }: ViewProps & { bodyScale: number }) {
  const s = 1 / EARTH_MEAN_RADIUS_M;
  const moonPos = eclToThree(state.moon_from_earth.position_m, s);
  const sunDir = normalize(eclToThree(state.sun_from_earth.position_m));
  const sunRadius = (SUN_PROXY_DIST * SUN_RADIUS_M) / state.sun_from_earth.distance_m;
  const track = useMemo(() => (tracks ? closeLoop(scaleTrack(tracks.moon_from_earth.positions_m, s)) : null), [tracks, s]);

  return (
    <>
      <ambientLight intensity={0.06} />
      <directionalLight position={times(sunDir, 100)} intensity={2.8} />
      <EclipticFrameHints radius={70} />
      {track && <Line points={track} color="#7d8aa5" lineWidth={1} transparent opacity={0.55} />}
      {trajectory && (
        <TrajectoryPath trajectory={trajectory} utc={state.utc} scale={s} arrivalMoon={arrivalMoon} moonRadius={MOON_RADIUS_KM * 1000 * s * bodyScale} />
      )}
      <Line points={[[0, 0, 0], moonPos]} color="#c9ced8" lineWidth={1} dashed dashSize={1.2} gapSize={0.8} />
      {/* Dashed line all the way to the (distance-compressed) Sun proxy, stopping at its limb. */}
      <Line points={[[0, 0, 0], times(sunDir, SUN_PROXY_DIST - sunRadius)]} color="#f2c14e" lineWidth={1.2} dashed dashSize={2} gapSize={1.2} />
      <Html position={[sunDir[0] * 92, sunDir[1] * 92 + 2, sunDir[2] * 92]} center className="axis-label sun">
        → toward Sun
      </Html>
      <Sun position={times(sunDir, SUN_PROXY_DIST)} radius={sunRadius} glowScale={60} label="Sun (true angular size, distance compressed)" />
      <Earth position={[0, 0, 0]} radius={bodyScale} orientation={earthOrientation} texture={earthTex} label="Earth" />
      <Moon position={moonPos} radius={MOON_RADIUS_KM * 1000 * s * bodyScale} orientation={moonOrientation} texture={moonTex} label="Moon" />
      <OrbitControls target={[0, 0, 0]} minDistance={3} maxDistance={900} />
    </>
  );
}

function SolarView({ state, earthTex, moonTex, earthOrientation, moonOrientation, tracks }: ViewProps) {
  const earthScale = SOLAR.earthOrbit / AU_M;
  const moonScale = SOLAR.moonDist / MEAN_MOON_DIST_M;
  const earthPos = times(eclToThree(state.sun_from_earth.position_m, earthScale), -1);
  const moonRel = eclToThree(state.moon_from_earth.position_m, moonScale);
  const moonPos: V3 = [earthPos[0] + moonRel[0], earthPos[1] + moonRel[1], earthPos[2] + moonRel[2]];
  // Earth's orbit = −(Earth→Sun track).
  const earthOrbit = useMemo(() => (tracks ? scaleTrack(tracks.sun_from_earth.positions_m, -earthScale) : null), [tracks, earthScale]);
  const moonTrack = useMemo(() => (tracks ? closeLoop(scaleTrack(tracks.moon_from_earth.positions_m, moonScale)) : null), [tracks, moonScale]);

  return (
    <>
      <ambientLight intensity={0.06} />
      <pointLight position={[0, 0, 0]} intensity={3} decay={0} />
      <EclipticFrameHints radius={SOLAR.earthOrbit * 1.15} />
      {earthOrbit && <Line points={earthOrbit} color="#5aa9ff" lineWidth={1} transparent opacity={0.45} />}
      {/* The Moon's geocentric trace, drawn around Earth's current position. */}
      <group position={earthPos}>
        {moonTrack && <Line points={moonTrack} color="#7d8aa5" lineWidth={1} transparent opacity={0.6} />}
      </group>
      <Line points={[[0, 0, 0], earthPos]} color="#5aa9ff" lineWidth={1} dashed dashSize={1.5} gapSize={1} />
      <Line points={[[0, 0, 0], moonPos]} color="#f2c14e" lineWidth={1} dashed dashSize={1.5} gapSize={1} />
      <Sun position={[0, 0, 0]} radius={SOLAR.sunRadius} glowScale={34} label="Sun" />
      <Earth position={earthPos} radius={SOLAR.earthRadius} orientation={earthOrientation} texture={earthTex} label="Earth" />
      <Moon position={moonPos} radius={SOLAR.moonRadius} orientation={moonOrientation} texture={moonTex} label="Moon" />
      <OrbitControls target={[0, 0, 0]} minDistance={8} maxDistance={600} />
    </>
  );
}

// memo: the dashboard re-renders on every date change before the new state arrives.
export const CelestialScene = memo(function CelestialScene({ state, view, enlargeBodies, active, onScale, footnote, offsetX = 0, trajectory = null, arrivalMoon = null }: Props) {
  const earthTex = useOptionalTexture(`${DATA_BASE}earth_bluemarble_2048.png`);
  const moonTex = useOptionalTexture(`${DATA_BASE}moon_color.jpg`);
  const earthOrientation = useMemo(() => bodyRotationToThree(state.earth_orientation), [state.earth_orientation]);
  const moonOrientation = useMemo(() => bodyRotationToThree(state.moon_orientation), [state.moon_orientation]);
  // Orbit traces: once per UTC day, not per tick.
  const day = Math.floor(Date.parse(state.utc) / DAY_MS);
  const [tracks, setTracks] = useState<CelestialTracksResponse | null>(null);
  const [tracksError, setTracksError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    getCelestialTracks(new Date(day * DAY_MS))
      .then((t) => current && (setTracks(t), setTracksError(null)))
      .catch((e) => current && (setTracks(null), setTracksError(e instanceof Error ? e.message : String(e))));
    return () => {
      current = false;
    };
  }, [day]);
  const viewProps: ViewProps = { state, earthTex, moonTex, earthOrientation, moonOrientation, tracks, trajectory, arrivalMoon };

  return (
    <div className="celestial-canvas">
      {/* key: remount on view change so the camera resets to that view's framing */}
      <Canvas
        key={view}
        camera={{ position: view === "earth-moon" ? [0, 75, 125] : [0, 70, 100], fov: 45, near: 0.1, far: 5000 }}
        dpr={[1, 2]}
        frameloop={active ? "always" : "never"}
      >
        <color attach="background" args={["#000000"]} />
        <StarField />
        <ViewShift x={offsetX} />
        {view === "earth-moon" ? (
          <>
            <EarthMoonView {...viewProps} bodyScale={enlargeBodies ? BODY_ENLARGEMENT : 1} />
            {onScale && <ScaleProbe onScale={onScale} />}
          </>
        ) : (
          <SolarView {...viewProps} />
        )}
      </Canvas>
      <div className="celestial-footnote">
        {footnote}
        <p className="caption">
          {view === "earth-moon" ? (
            <>
              <b>Earth–Moon, distances to scale</b> (1 unit = 1 Earth radius);{" "}
              {enlargeBodies ? <b className="warn-text">Earth &amp; Moon radii enlarged ×{BODY_ENLARGEMENT}.</b> : <>Earth &amp; Moon at true size.</>} The Sun is drawn at a compressed distance with its true
              angular size; lighting follows the SPICE Sun direction. Grey trace: SPICE Moon path over one sidereal month (27.3 d) centred on the day; the real path does not quite close (solar perturbations), the small residual is spread along the trace for display.
              {trajectory && (
                <>
                  {" "}
                  <span style={{ color: SEGMENT_COLOUR.transfer }}>Cyan</span>: computed Earth→Moon transfer,{" "}
                  <span style={{ color: SEGMENT_COLOUR.descent }}>orange</span>: powered descent (vecteur-traj, geocentric, true scale; wireframe Moon = SPICE Moon at the arrival instant
                  {enlargeBodies ? "; the descent ends on the true-size Moon, inside the enlarged sphere" : ""}).
                </>
              )}
            </>
          ) : (
            <>
              <b>Sun–Earth–Moon, schematic — NOT to scale.</b> Directions follow the SPICE (DE440, geometric) state; distances are compressed and radii
              exaggerated. Earth–Moon distance shown ×{Math.round((SOLAR.moonDist / MEAN_MOON_DIST_M) / (SOLAR.earthOrbit / AU_M))}{" "}
              relative to the Sun–Earth distance.
            </>
          )}{" "}
          Ecliptic plane grid, +X = equinox J2000. Moon orientation from SPICE (MOON_ME, librations included). Earth rotation: IAU model (texture only).{" "}
          {tracksError && <span className="warn-text">Orbit traces unavailable: {tracksError}. </span>}
          Shadows/eclipses are not rendered.{" "}
          {earthTex && moonTex ? (
            <>Textures: NASA SVS Blue Marble (SVS 2915) &amp; LROC WAC colour mosaic (SVS 4720).</>
          ) : (
            <span className="warn-text">Textures not installed — {SETUP_HINT}.</span>
          )}
        </p>
      </div>
    </div>
  );
});

function StarField() {
  const stars = useMemo(() => makeStarField(4000), []);
  useEffect(() => () => disposeStarField(stars), [stars]);
  useFrame(({ camera }) => stars.position.copy(camera.position));
  return <primitive object={stars} />;
}

function ViewShift({ x }: { x: number }) {
  const camera = useThree((s) => s.camera) as PerspectiveCamera;
  const width = useThree((s) => s.size.width);
  const height = useThree((s) => s.size.height);
  useEffect(() => {
    camera.setViewOffset(width, height, -x, 0, width, height);
    camera.updateProjectionMatrix();
    return () => {
      camera.clearViewOffset();
    };
  }, [camera, width, height, x]);
  return null;
}

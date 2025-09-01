import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import * as THREE from "three";
import { OrbitControls, Html, Grid, GizmoHelper, GizmoViewport, Billboard, Text } from "@react-three/drei";

/**
 * 3D Camera Frustums Viewer
 *
 * - Drop or choose a JSON file with fields:
 *   {
 *     "camera_angle_x": <radians>, // horizontal FOV in radians
 *     "frames": [
 *       { file_path: string, time?: number, transform_matrix: number[4][4] }, ...
 *     ]
 *   }
 * - Renders each camera as a truncated pyramid (frustum) in world space using the supplied c2w transform.
 * - Interactive: orbit, pan, zoom; tweak near/far/aspect/scale; toggle grid/axes/labels; Fit View.
 *
 * Notes on conventions:
 * - Assumes transform_matrix is camera-to-world (c2w) in a right-handed system with camera looking down -Z, +Y up.
 * - If your dataset differs (e.g., w2c), toggle "Invert matrices" to flip.
 */

// -------------------------- Helpers --------------------------

function matrix4FromRows(rows) {
  // rows: number[4][4] in row-major
  const m = new THREE.Matrix4();
  const flat = [
    rows[0][0], rows[0][1], rows[0][2], rows[0][3],
    rows[1][0], rows[1][1], rows[1][2], rows[1][3],
    rows[2][0], rows[2][1], rows[2][2], rows[2][3],
    rows[3][0], rows[3][1], rows[3][2], rows[3][3],
  ];
  m.set(...flat);
  return m;
}

function computeFrustumCornersLocal(fovX, aspect, n, f) {
  // fovX: horizontal FOV in radians
  // returns 8 Vector3 in camera local space: N0..N3, F0..F3 (counterclockwise from bottom-left)
  const t = Math.tan(fovX / 2);
  const safeAspect = Math.max(1e-6, aspect);
  const wN = n * t;
  const hN = wN / safeAspect;
  const wF = f * t;
  const hF = wF / safeAspect;
  const N0 = new THREE.Vector3(-wN, -hN, -n);
  const N1 = new THREE.Vector3( wN, -hN, -n);
  const N2 = new THREE.Vector3( wN,  hN, -n);
  const N3 = new THREE.Vector3(-wN,  hN, -n);
  const F0 = new THREE.Vector3(-wF, -hF, -f);
  const F1 = new THREE.Vector3( wF, -hF, -f);
  const F2 = new THREE.Vector3( wF,  hF, -f);
  const F3 = new THREE.Vector3(-wF,  hF, -f);
  return [N0,N1,N2,N3,F0,F1,F2,F3];
}

function buildFrustumEdges(corners) {
  // edges as index pairs into corners array
  const pairs = [
    // near rectangle
    [0,1],[1,2],[2,3],[3,0],
    // far rectangle
    [4,5],[5,6],[6,7],[7,4],
    // sides
    [0,4],[1,5],[2,6],[3,7],
  ];
  const positions = new Float32Array(pairs.length * 2 * 3);
  let i = 0;
  for (const [a,b] of pairs) {
    positions[i++] = corners[a].x; positions[i++] = corners[a].y; positions[i++] = corners[a].z;
    positions[i++] = corners[b].x; positions[i++] = corners[b].y; positions[i++] = corners[b].z;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  return geom;
}

function applyMatrixToGeometry(geometry, matrix) {
  const g = geometry.clone();
  g.applyMatrix4(matrix);
  return g;
}

function hslColor(i, n, s = 0.6, l = 0.5) {
  const hue = (i / Math.max(1, n)) * 360;
  const c = new THREE.Color();
  c.setHSL(hue / 360, s, l);
  return c;
}

// -------------------------- 3D Components --------------------------

function FitViewButton({ geoms }) {
  const { camera } = useThree((s) => ({ camera: s.camera }));

  const onFit = useCallback(() => {
    if (!geoms?.length) return;
    const box = new THREE.Box3();
    for (const g of geoms) {
      if (!g) continue;
      const pos = g.getAttribute?.("position");
      if (!pos) continue;
      const b = new THREE.Box3().setFromBufferAttribute(pos);
      box.union(b);
    }
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const sizeV = box.getSize(new THREE.Vector3());
    const maxSize = Math.max(sizeV.x, sizeV.y, sizeV.z);
    const fov = THREE.MathUtils.degToRad(camera.fov ?? 50);
    const dist = (maxSize / 2) / Math.tan(fov / 2);
    const dir = new THREE.Vector3(1, 1, 1).normalize();
    camera.position.copy(center.clone().add(dir.multiplyScalar(dist * 1.5)));
    camera.near = Math.max(0.01, dist / 1000);
    camera.far = dist * 1000;
    camera.updateProjectionMatrix();
    camera.lookAt(center);
  }, [geoms, camera]);

  return (
    <button
      onClick={onFit}
      className="px-3 py-1 rounded-xl bg-white/90 hover:bg-white shadow-sm text-sm font-medium border border-slate-300 text-slate-900"
      title="Fit view to frustums"
    >
      Fit View
    </button>
  );
}

function FrustumLines({ id, matrix, color, fovX, aspect, near, far, label, isSelected, onSelect }) {
  // Compute local corners -> transform by matrix
  const baseGeom = useMemo(() => {
    const corners = computeFrustumCornersLocal(fovX, aspect, near, far);
    return buildFrustumEdges(corners);
  }, [fovX, aspect, near, far]);

  const worldGeom = useMemo(() => applyMatrixToGeometry(baseGeom, matrix), [baseGeom, matrix]);

  // Camera origin in world for label placement
  const origin = useMemo(() => new THREE.Vector3(0,0,0).applyMatrix4(matrix), [matrix]);
  const hotspotRadius = 0.4; // click target near camera origin

  return (
    <group>
      <lineSegments
        onClick={(e) => { e.stopPropagation(); onSelect?.(id); }}
      >
        <primitive object={worldGeom} attach="geometry" />
        <lineBasicMaterial attach="material" linewidth={1} color={color} />
      </lineSegments>
      {/* Hover hotspot at the camera origin to reveal label */}
      <mesh
        position={origin.toArray()}
        onClick={(e) => { e.stopPropagation(); onSelect?.(id); }}
      >
        <sphereGeometry args={[hotspotRadius, 8, 8]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} />
      </mesh>
      {isSelected && (
        <Billboard position={origin.toArray()}>
          <Text
            fontSize={0.08}
            color="#111"
            anchorX="center"
            anchorY="bottom"
            outlineWidth={0.0015}
            outlineColor="#fff"
            renderOrder={999}
            material-depthTest={false}
            material-toneMapped={false}
          >
            {label}
          </Text>
        </Billboard>
      )}
    </group>
  );
}

function Scene({ cameras = [], controls = {}, selectedId, setSelectedId }) {
  const {
    fovX = THREE.MathUtils.degToRad(60),
    aspect = 1.5,
    near = 0.1,
    far = 2.0,
    showGrid = true,
    showAxes = true,
    showLabels = true,
  } = controls || {};

  const geomsRef = useRef([]);

  // Build line geometries once for FitView
  const geoms = useMemo(() => {
    const base = buildFrustumEdges(computeFrustumCornersLocal(fovX, aspect, near, far));
    return (cameras || []).map((c) => applyMatrixToGeometry(base, c.matrix));
  }, [cameras, fovX, aspect, near, far]);
  geomsRef.current = geoms;

  return (
    <>
      <ambientLight intensity={0.7} />
      <directionalLight position={[5, 10, 7]} intensity={0.6} />

      {showGrid && <Grid args={[50, 50]} infiniteGrid cellSize={1} cellColor="#999" sectionColor="#666" fadeDistance={40} />}
      {showAxes && (
        <GizmoHelper alignment="bottom-right" margin={[80, 80]}> 
          <GizmoViewport axisColors={["#c23", "#2a2", "#22a"]} labelColor="black" />
        </GizmoHelper>
      )}

      {(cameras || []).map((c, i) => (
        <FrustumLines
          key={i}
          id={c.id}
          matrix={c.matrix}
          color={c.color ?? hslColor(i, cameras.length)}
          fovX={fovX}
          aspect={aspect}
          near={near}
          far={far}
          label={c.label}
          isSelected={selectedId === c.id || showLabels}
          onSelect={setSelectedId}
        />
      ))}

      <OrbitControls makeDefault />
      <Html position={[0,0,0]} prepend>
        <div className="absolute left-4 top-4 flex items-center gap-2">
          <FitViewButton geoms={geomsRef.current} />
        </div>
      </Html>
    </>
  );
}

function CaptureRegistrar({ setSavePngFn }) {
  // Registers a capture function that renders with black background and 4:3 aspect
  const { gl, scene, camera } = useThree((s) => ({ gl: s.gl, scene: s.scene, camera: s.camera }));

  useEffect(() => {
    if (!gl || !scene || !camera || !setSavePngFn) return;

    const save = () => {
      const renderer = gl;
      const canvas = renderer.domElement;
      if (!canvas) return;

      const width = canvas.width;
      const height = canvas.height;
      const targetW = Math.min(width, Math.floor(height * 4 / 3));
      const targetH = Math.min(height, Math.floor(width * 3 / 4));
      const offsetX = Math.floor((width - targetW) / 2);
      const offsetY = Math.floor((height - targetH) / 2);

      const filename = `camera-frustums-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;

      // Save renderer and camera state
      const prevClearColor = renderer.getClearColor(new THREE.Color());
      const prevClearAlpha = renderer.getClearAlpha();
      const prevAutoClear = renderer.autoClear;
      const prevScissorTest = renderer.getScissorTest ? renderer.getScissorTest() : false;
      const isPerspective = typeof camera.aspect === 'number';
      const prevAspect = isPerspective ? camera.aspect : undefined;

      try {
        // Set black background and render with 4:3 aspect
        renderer.setClearColor(0x000000, 1);
        renderer.autoClear = true;
        // Clear full canvas to black first
        renderer.setViewport(0, 0, width, height);
        renderer.setScissor(0, 0, width, height);
        renderer.setScissorTest(true);
        renderer.clear(true, true, true);

        if (isPerspective) {
          camera.aspect = 4 / 3;
          camera.updateProjectionMatrix?.();
        }

        // Render into centered 4:3 viewport
        renderer.setViewport(offsetX, offsetY, targetW, targetH);
        renderer.setScissor(offsetX, offsetY, targetW, targetH);
        renderer.setScissorTest(true);
        renderer.render(scene, camera);

        // Crop to largest centered 4:3 area
        const exportCanvas = document.createElement('canvas');
        exportCanvas.width = targetW;
        exportCanvas.height = targetH;
        const ctx = exportCanvas.getContext('2d');
        ctx.drawImage(canvas, offsetX, offsetY, targetW, targetH, 0, 0, targetW, targetH);

        if (exportCanvas.toBlob) {
          exportCanvas.toBlob((blob) => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          }, 'image/png');
        } else {
          const dataUrl = exportCanvas.toDataURL('image/png');
          const a = document.createElement('a');
          a.href = dataUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          a.remove();
        }
      } finally {
        // Restore state
        renderer.setClearColor(prevClearColor, prevClearAlpha);
        renderer.autoClear = prevAutoClear;
        renderer.setViewport(0, 0, width, height);
        renderer.setScissor(0, 0, width, height);
        renderer.setScissorTest(prevScissorTest);
        if (isPerspective && prevAspect) {
          camera.aspect = prevAspect;
          camera.updateProjectionMatrix?.();
        }
      }
    };

    const wrapped = () => requestAnimationFrame(save);
    setSavePngFn(() => wrapped);
    return () => setSavePngFn(null);
  }, [gl, scene, camera, setSavePngFn]);

  return null;
}

// -------------------------- Main App --------------------------

export default function CameraFrustumsApp() {
  const [groups, setGroups] = useState([]); // [{id,name,data:{camera_angle_x,frames:[]}, color, visible}]
  const [error, setError] = useState("");

  // Visualization controls
  const [aspect, setAspect] = useState(1.5); // width/height
  const [near, setNear] = useState(0.1);
  const [far, setFar] = useState(2.0);
  const [scale, setScale] = useState(0.1); // scales near/far distances (default 0.1)
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [showLabels, setShowLabels] = useState(false);
  const [invertMatrices, setInvertMatrices] = useState(false);
  const [worldUp, setWorldUp] = useState('z'); // 'y' or 'z' (default Z-up)
  const [selectedId, setSelectedId] = useState(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const canvasRef = useRef(null); // holds WebGL canvas element
  const [savePngFn, setSavePngFn] = useState(null); // capture function registered from Canvas

  const fovX = useMemo(() => {
    // Use the first group's camera_angle_x if present
    return groups[0]?.data?.camera_angle_x ?? THREE.MathUtils.degToRad(60);
  }, [groups]);

  const cameras = useMemo(() => {
    if (!groups?.length) return [];
    const zToY = new THREE.Matrix4().makeRotationX(-Math.PI / 2); // maps Z-up world to Y-up
    const cams = [];
    groups.forEach((g, gi) => {
      if (!g?.visible) return;
      const frames = g.data?.frames || [];
      frames.forEach((f, idx) => {
        const m = matrix4FromRows(f.transform_matrix);
        if (invertMatrices) m.invert();
        const worldAligned = worldUp === 'z' ? zToY.clone().multiply(m) : m;
        cams.push({
          id: `${g.id}:${idx}`,
          label: `${g.name ?? `group_${gi}`}/${f.file_path ?? `cam_${idx}`}`,
          matrix: worldAligned,
          color: g.color,
        });
      });
    });
    return cams;
  }, [groups, invertMatrices, worldUp]);

  const onFiles = useCallback(async (fileList) => {
    try {
      setError("");
      const files = Array.from(fileList || []);
      if (!files.length) return;
      // Parse all files first
      const parsed = [];
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data.frames || !Array.isArray(data.frames)) throw new Error("Missing 'frames' array");
        const name = (file.name || `group_${i}`).replace(/\.[^.]+$/, "");
        parsed.push({ name, data });
      }
      setGroups((prev) => {
        const next = [...prev];
        const additions = [];
        parsed.forEach((p, idx) => {
          const existingIdx = next.findIndex((g) => g.name === p.name);
          if (existingIdx >= 0) {
            // Replace data for existing group (keeps color/visibility/id)
            next[existingIdx] = { ...next[existingIdx], data: p.data };
          } else {
            const color = hslColor(prev.length + additions.length, prev.length + parsed.length);
            additions.push({ id: `${Date.now()}_${idx}`, name: p.name, data: p.data, color, visible: true });
          }
        });
        return [...next, ...additions];
      });
    } catch (e) {
      console.error(e);
      setError(e.message || String(e));
    }
  }, []);

  const onInputChange = useCallback((e) => {
    const files = e.target.files;
    if (files?.length) onFiles(files);
  }, [onFiles]);

  // Drag & drop support
  const dropRef = useRef(null);
  useEffect(() => {
    const prevent = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
    const onDrop = (ev) => {
      prevent(ev);
      const files = ev.dataTransfer?.files;
      if (files?.length) onFiles(files);
    };
    // Global listeners so drop works anywhere
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", onDrop);
    };
  }, [onFiles]);

  // -------------------------- Self-tests --------------------------
  const [selfTests, setSelfTests] = useState([]);
  useEffect(() => {
    const tests = [];
    try {
      const corners = computeFrustumCornersLocal(THREE.MathUtils.degToRad(60), 1.5, 0.1, 2);
      tests.push({ name: "frustum corners count", pass: corners.length === 8 });
    } catch (e) {
      tests.push({ name: "frustum corners count", pass: false, err: String(e) });
    }
    try {
      const m = matrix4FromRows([[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]]);
      const v = new THREE.Vector3(0,0,-1).applyMatrix4(m);
      tests.push({ name: "matrix4FromRows identity", pass: v.z === -1 });
    } catch (e) {
      tests.push({ name: "matrix4FromRows identity", pass: false, err: String(e) });
    }
    try {
      // buildFrustumEdges creates 12 line pairs => 24 vertices
      const corners = computeFrustumCornersLocal(THREE.MathUtils.degToRad(60), 1.5, 0.1, 2);
      const geom = buildFrustumEdges(corners);
      const pos = geom.getAttribute("position");
      tests.push({ name: "frustum edges vertex count", pass: !!pos && pos.count === 24 });
    } catch (e) {
      tests.push({ name: "frustum edges vertex count", pass: false, err: String(e) });
    }
    try {
      // matrix * inverse ≈ identity
      const m = matrix4FromRows([[1,0,0,2],[0,1,0,3],[0,0,1,4],[0,0,0,1]]);
      const inv = m.clone().invert();
      const prod = m.clone().multiply(inv);
      const id = new THREE.Matrix4();
      const diff = prod.elements.map((v,i)=>Math.abs(v - id.elements[i]));
      const maxErr = Math.max(...diff);
      tests.push({ name: "matrix inversion correctness", pass: maxErr < 1e-6 });
    } catch (e) {
      tests.push({ name: "matrix inversion correctness", pass: false, err: String(e) });
    }
    try {
      // aspect safety (no NaN)
      const corners = computeFrustumCornersLocal(THREE.MathUtils.degToRad(60), 0, 0.1, 2);
      const ok = corners.every(v=>Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z));
      tests.push({ name: "aspect zero handled", pass: ok });
    } catch (e) {
      tests.push({ name: "aspect zero handled", pass: false, err: String(e) });
    }
    setSelfTests(tests);
  }, []);

  // Derived distances
  const nearScaled = Math.max(1e-4, near * scale);
  const farScaled = Math.max(nearScaled + 1e-4, far * scale);

  // Sample JSON (for quick testing)
  const sampleGroups = useMemo(() => ([_makeGroup("train", 0), _makeGroup("val", 1), _makeGroup("test", 2)]), []);

  function _makeGroup(name, idx) {
    return {
      id: `sample_${name}`,
      name,
      color: hslColor(idx, 3),
      visible: true,
      data: {
        camera_angle_x: THREE.MathUtils.degToRad(60),
        frames: [
          { file_path: `${name}_0`, transform_matrix: [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]] },
          { file_path: `${name}_1`, transform_matrix: [[1,0,0,2],[0,1,0,1],[0,0,1,2],[0,0,0,1]] },
          { file_path: `${name}_2`, transform_matrix: [[0,-1,0,0],[1,0,0,0],[0,0,1,2],[0,0,0,1]] },
        ]
      }
    };
  }

  return (
    <div
      className="w-full h-full min-h-screen flex flex-col bg-gradient-to-b from-slate-50 to-slate-100 text-slate-900"
      onMouseDown={() => setSelectedId(null)}
    >
      {/* Top bar */}
      <div className="sticky top-0 z-20 backdrop-blur bg-white/70 border-b border-black/5">
        <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3">
          <div className="text-lg font-bold tracking-tight">3D Camera Frustums Viewer</div>

          <label className="ml-auto text-sm font-medium px-3 py-1.5 rounded-xl bg-slate-900 text-white cursor-pointer hover:bg-slate-700">
            Load JSON
            <input type="file" multiple accept=".json,application/json" className="hidden" onChange={onInputChange} />
          </label>

          <button
            className="text-sm font-medium px-3 py-1.5 rounded-xl bg-white border border-black/10 hover:bg-slate-50"
            onClick={() => setGroups(sampleGroups)}
            title="Load built-in sample groups (train/val/test)"
          >
            Load Sample
          </button>

          <button
            className="text-sm font-medium px-3 py-1.5 rounded-xl bg-white border border-black/10 hover:bg-slate-50"
            onClick={() => {
              if (typeof savePngFn === 'function') {
                savePngFn();
                return;
              }
              // Fallback: simple canvas capture if registrar not ready
              const canvas = canvasRef.current;
              if (!canvas) return;
              const filename = `camera-frustums-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
              requestAnimationFrame(() => {
                const a = document.createElement('a');
                a.href = canvas.toDataURL('image/png');
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                a.remove();
              });
            }}
            title="Save current view as PNG"
            aria-label="Save PNG"
          >
            Save PNG
          </button>
        </div>
      </div>

      {/* Drop zone / info */}
      {!groups.length && (
        <div ref={dropRef} className="max-w-3xl mx-auto mt-8 px-6 py-6 rounded-2xl border border-dashed border-slate-300 bg-white/70 text-center">
          <div className="text-xl font-semibold">Drop your camera JSON here</div>
          <div className="mt-2 text-slate-600">…or use the <span className="font-medium">Load JSON</span> button above</div>
          <div className="mt-4 text-sm text-left opacity-80">
            <div className="font-semibold mb-1">Expected structure</div>
            <pre className="bg-slate-50 p-3 rounded-lg overflow-auto text-xs border border-black/5">{`{
  "camera_angle_x": 0.7,
  "frames": [
    { "file_path": "./img_000", "transform_matrix": [[...],[...],[...],[...]] },
    …
  ]
}`}</pre>
          </div>
          {error && <div className="mt-3 text-rose-600 font-medium">{error}</div>}
        </div>
      )}

      {/* Groups panel (moved to overlay in 3D view) */}

      {/* 3D View */}
      <div className="relative mt-4 w-full flex-1 min-h-[50vh]">
        {groups.length > 0 && (
          <div className="absolute left-4 top-16 z-10 w-[480px] max-h-[70vh] overflow-auto rounded-xl bg-white/90 backdrop-blur border border-slate-300 shadow-md p-4 text-sm">
            <div className="font-semibold mb-3">Groups</div>
            <div className="flex flex-col divide-y divide-slate-200">
              {groups.map((g, i) => (
                <div key={g.id} className="flex items-center gap-3 py-2">
                  <button
                    className={`shrink-0 w-5 h-5 rounded-none flex items-center justify-center transition-all ${g.visible ? 'ring-2 ring-slate-400' : ''}`}
                    style={{ background: g.color?.getStyle?.() ?? g.color }}
                    onClick={() => setGroups(prev=>prev.map((pg,j)=> j===i?{...pg,visible:!pg.visible}:pg))}
                    title={g.visible ? 'Click to hide this group' : 'Click to show this group'}
                    aria-pressed={g.visible}
                  >
                    {g.visible ? <span className="text-white text-xs leading-none">✓</span> : null}
                  </button>
                  <input
                    className="flex-1 min-w-0 px-2 py-1 rounded-md border border-slate-300 bg-white text-slate-900"
                    value={g.name}
                    onChange={(e)=>setGroups(prev=>prev.map((pg,j)=> j===i?{...pg,name:e.target.value}:pg))}
                  />
                  <div className="text-xs opacity-70 whitespace-nowrap ml-auto">{g.data?.frames?.length ?? 0} cams</div>
                  <button
                    className="shrink-0 p-1 rounded-md border border-slate-300 hover:bg-slate-50 bg-white text-slate-700 shadow-sm"
                    onClick={()=>setGroups(prev=>prev.filter((_,j)=>j!==i))}
                    aria-label={`Remove group ${g.name}`}
                    title="Remove group"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                      <path d="M9 3a1 1 0 0 0-1 1v1H5.5a1 1 0 1 0 0 2H6v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7h.5a1 1 0 1 0 0-2H16V4a1 1 0 0 0-1-1H9zm2 2h2V5h-2v0zm-2 5a1 1 0 1 1 2 0v8a1 1 0 1 1-2 0V10zm6-1a1 1 0 0 1 1 1v8a1 1 0 1 1-2 0V10a1 1 0 0 1 1-1z" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        <Canvas
          className="w-full h-full"
          camera={{ position: [6, 4, 6], fov: 50 }}
          gl={{ preserveDrawingBuffer: true }}
          onCreated={({ gl }) => { canvasRef.current = gl.domElement; }}
          dpr={[1, 2]}
          raycaster={{ params: { Line: { threshold: 0.1 }}}}
          onPointerDown={(e)=>e.stopPropagation()}
          onPointerMissed={() => setSelectedId(null)}
        >
          <CaptureRegistrar setSavePngFn={setSavePngFn} />
          <Scene
            cameras={cameras}
            controls={{ fovX, aspect, near: nearScaled, far: farScaled, showGrid, showAxes, showLabels }}
            selectedId={selectedId}
            setSelectedId={setSelectedId}
          />
        </Canvas>
      </div>

      {/* Bottom controls bar (moved from top) */}
      <div className="sticky bottom-0 z-20 backdrop-blur bg-white/70 border-t border-black/5">
        <div className="max-w-6xl mx-auto px-4 py-3 flex flex-wrap items-center gap-3 text-sm">
          <div className="flex items-center gap-1">
            <span className="opacity-60">Aspect</span>
            <input type="number" step="0.01" value={aspect} onChange={e=>setAspect(parseFloat(e.target.value)||1)} className="w-20 px-2 py-1 rounded-md border border-black/10" />
          </div>
          <div className="flex items-center gap-1">
            <span className="opacity-60">Near</span>
            <input type="number" step="0.01" value={near} onChange={e=>setNear(Math.max(0.001, parseFloat(e.target.value)||0.1))} className="w-20 px-2 py-1 rounded-md border border-black/10" />
          </div>
          <div className="flex items-center gap-1">
            <span className="opacity-60">Far</span>
            <input type="number" step="0.01" value={far} onChange={e=>setFar(Math.max(near, parseFloat(e.target.value)||2))} className="w-20 px-2 py-1 rounded-md border border-black/10" />
          </div>
          <div className="flex items-center gap-1">
            <span className="opacity-60">Scale</span>
            <input type="number" step="0.1" value={scale} onChange={e=>setScale(Math.max(0.01, parseFloat(e.target.value)||1))} className="w-20 px-2 py-1 rounded-md border border-black/10" />
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1"><input type="checkbox" checked={showGrid} onChange={e=>setShowGrid(e.target.checked)} /> Grid</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={showAxes} onChange={e=>setShowAxes(e.target.checked)} /> Axes</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={showLabels} onChange={e=>setShowLabels(e.target.checked)} /> Labels</label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={invertMatrices} onChange={e=>setInvertMatrices(e.target.checked)} /> Invert matrices</label>
            <label className="flex items-center gap-1">
              <span className="opacity-60">World Up</span>
              <select value={worldUp} onChange={e=>setWorldUp(e.target.value)} className="px-2 py-1 rounded-md border border-black/10">
                <option value="y">Y-up (Three)</option>
                <option value="z">Z-up (Blender)</option>
              </select>
            </label>
            <label className="flex items-center gap-1"><input type="checkbox" checked={showDiagnostics} onChange={e=>setShowDiagnostics(e.target.checked)} /> Diagnostics</label>
          </div>
        </div>
      </div>

      {/* Footer info + self tests (toggleable) */}
      {showDiagnostics && (
        <div className="max-w-6xl mx-auto px-4 py-4 text-sm text-slate-600">
          {groups.length ? (
            <>
              Loaded <span className="font-semibold">{groups.reduce((s,g)=>s+(g.data?.frames?.length||0),0)}</span> cameras in {groups.length} group{groups.length===1?'':'s'}
              {typeof fovX === 'number' && (
                <> • FOVx = {fovX.toFixed(4)} rad ({THREE.MathUtils.radToDeg(fovX).toFixed(1)}°)</>
              )}
            </>
          ) : (
            <>
              No JSON loaded yet. Use <em>Load Sample</em> for a quick test.
            </>
          )}
          <div className="mt-2">
            <span className="font-semibold">Self-tests:</span>{' '}
            {selfTests.length ? (
              <>
                {selfTests.filter(t=>t.pass).length}/{selfTests.length} passed
                <ul className="list-disc ml-5">
                  {selfTests.map((t,i)=>(
                    <li key={i} className={t.pass?"text-green-700":"text-rose-700"}>
                      {t.name}{!t.pass && t.err?`: ${t.err}`:""}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              "running…"
            )}
          </div>
        </div>
      )}
    </div>
  );
}

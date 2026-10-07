// scene3d.js — the venue map as a 3D city. Each venue is a lit pillar placed at its
// real lat/lng; height is whatever metric you're looking at, colour is pipeline stage.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const STAGE_COLOR = {
  prospect: 0x707e9e, researching: 0x6fa8ff, contacted: 0x7c5cff, in_conversation: 0x21e6c1,
  negotiating: 0xffb020, booked: 0x38d67a, played: 0x2fbf6b, repeat: 0xff3d81, passed: 0x4a5164,
};

export function createVenueScene(container, venues, opts = {}) {
  const metric = opts.metric || 'capacity';
  const onPick = opts.onPick || (() => {});
  const pts = venues.filter(v => v.lat != null && v.lng != null);

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x05060a);
  scene.fog = new THREE.FogExp2(0x05060a, 0.0032);

  const camera = new THREE.PerspectiveCamera(42, container.clientWidth / container.clientHeight, 0.5, 3000);
  // Framing is computed from the data below — the territory grows every time a sweep
  // adds an area, and a hardcoded camera turns an outlying town into a distant smudge.
  const home = new THREE.Vector3(0, 118, 176);
  camera.position.copy(home);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.maxPolarAngle = Math.PI / 2.06;
  controls.minDistance = 18;
  controls.maxDistance = 420;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.32;
  controls.addEventListener('start', () => { controls.autoRotate = false; });

  scene.add(new THREE.AmbientLight(0x8899cc, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 0.8);
  key.position.set(60, 120, 40);
  scene.add(key);
  const violet = new THREE.PointLight(0x7c5cff, 260, 400);
  violet.position.set(-70, 50, -40);
  scene.add(violet);
  const cyan = new THREE.PointLight(0x21e6c1, 220, 400);
  cyan.position.set(80, 40, 60);
  scene.add(cyan);

  // ── geographic projection ──
  const lats = pts.map(p => p.lat), lngs = pts.map(p => p.lng);
  const bounds = {
    minLat: Math.min(...lats), maxLat: Math.max(...lats),
    minLng: Math.min(...lngs), maxLng: Math.max(...lngs),
  };
  const midLat = (bounds.minLat + bounds.maxLat) / 2;
  const SPAN = 190;
  const lngScale = Math.cos(midLat * Math.PI / 180);
  const w = Math.max(0.001, (bounds.maxLng - bounds.minLng) * lngScale);
  const h = Math.max(0.001, bounds.maxLat - bounds.minLat);
  const scale = SPAN / Math.max(w, h);
  const project = (lat, lng) => ({
    x: ((lng - bounds.minLng) * lngScale - w / 2) * scale,
    z: -((lat - bounds.minLat) - h / 2) * scale,
  });

  // ── ground ──
  const grid = new THREE.GridHelper(SPAN * 1.7, 34, 0x1b2030, 0x11141d);
  grid.material.transparent = true;
  grid.material.opacity = 0.55;
  scene.add(grid);
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(SPAN * 0.95, 64).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x080a10, transparent: true, opacity: 0.9 })
  );
  floor.position.y = -0.2;
  scene.add(floor);

  // ── pillars ──
  const metricValue = (v) => {
    if (metric === 'revenue') return v.revenue || 0;
    if (metric === 'score') return v.score || 0;
    if (metric === 'capacity') return v.capacity || 0;
    return 1;
  };
  const maxVal = Math.max(1, ...pts.map(metricValue));
  const geo = new THREE.CylinderGeometry(0.95, 1.25, 1, 12, 1, false);
  geo.translate(0, 0.5, 0);                       // grow upward from the ground
  // Basic (unlit) material: instanceColor comes through at full strength, so a pillar's
  // colour reads as its pipeline stage from across the room. Lighting would mute exactly
  // the signal this view exists to carry.
  const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, pts.length));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const colorAttr = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, pts.length) * 3), 3);
  mesh.instanceColor = colorAttr;
  const dummy = new THREE.Object3D();
  const heights = [];

  function layout(animate = true) {
    pts.forEach((v, i) => {
      const p = project(v.lat, v.lng);
      const raw = metricValue(v);
      const hgt = 1.2 + (raw / maxVal) * 40;
      heights[i] = hgt;
      dummy.position.set(p.x, 0, p.z);
      dummy.scale.set(1.05, animate ? 0.01 : hgt, 1.05);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      const c = new THREE.Color(STAGE_COLOR[v.stage] ?? 0x6a7183);
      colorAttr.setXYZ(i, c.r, c.g, c.b);
    });
    mesh.instanceMatrix.needsUpdate = true;
    colorAttr.needsUpdate = true;
  }
  layout(true);
  scene.add(mesh);

  // Fit the camera to the projected footprint, on the narrower of the two screen axes.
  {
    // Frame the 5th–95th percentile, not the extremes: two far-off venues should
    // not zoom the whole map out until the main cluster is a smudge. The outliers stay
    // reachable by zooming out; the default view shows where the work is.
    const band = (arr) => {
      const s = arr.slice().sort((a, b) => a - b);
      const lo = s[Math.floor(s.length * 0.05)], hi = s[Math.ceil(s.length * 0.95) - 1];
      return [lo, hi];
    };
    const [x0, x1] = band(pts.map(v => project(v.lat, v.lng).x));
    const [z0, z1] = band(pts.map(v => project(v.lat, v.lng).z));
    const extentX = Math.max(20, x1 - x0);
    const extentZ = Math.max(20, z1 - z0);
    const cx = (x0 + x1) / 2;
    const cz = (z0 + z1) / 2;
    const vFov = camera.fov * Math.PI / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const dist = Math.max(extentZ / 2 / Math.tan(vFov / 2), extentX / 2 / Math.tan(hFov / 2)) * 1.25 + 40;
    controls.target.set(cx, 0, cz);
    home.set(cx, dist * 0.55, cz + dist * 0.82);
    camera.position.copy(home);
    camera.lookAt(controls.target);
    controls.maxDistance = dist * 2.6;
  }

  // Soft glow discs under high-value venues — reads as light spill on the floor.
  const glowTex = makeGlowTexture();
  const glowGroup = new THREE.Group();
  const glowSet = new Set([...pts].sort((a, b) => metricValue(b) - metricValue(a)).slice(0, 50));
  pts.forEach((v) => {
    if (!glowSet.has(v)) return;
    const p = project(v.lat, v.lng);
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTex, color: STAGE_COLOR[v.stage] ?? 0x6a7183, transparent: true, opacity: 0.3, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.position.set(p.x, 0.4, p.z);
    s.scale.set(11, 11, 1);
    glowGroup.add(s);
  });
  scene.add(glowGroup);

  // ── picking ──
  const ray = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  let hovered = -1;
  const hud = document.createElement('div');
  hud.className = 'stage-hud hide';
  container.appendChild(hud);

  function pointerFrom(e) {
    const r = renderer.domElement.getBoundingClientRect();
    const cx = e.touches ? e.touches[0].clientX : e.clientX;
    const cy = e.touches ? e.touches[0].clientY : e.clientY;
    pointer.x = ((cx - r.left) / r.width) * 2 - 1;
    pointer.y = -((cy - r.top) / r.height) * 2 + 1;
  }
  function hit() {
    ray.setFromCamera(pointer, camera);
    const is = ray.intersectObject(mesh);
    return is.length ? is[0].instanceId : -1;
  }
  function showHud(i) {
    const v = pts[i];
    if (!v) return hud.classList.add('hide');
    hud.classList.remove('hide');
    hud.innerHTML = `<b>${escapeHtml(v.name)}</b>
      <div class="muted" style="font-size:11.5px">${escapeHtml([v.city, v.state].filter(Boolean).join(', '))}</div>
      <div class="muted" style="font-size:11.5px">${escapeHtml(v.venue_type || '')}${v.capacity ? ` · ~${v.capacity} cap` : ''}</div>
      <div style="font-size:11.5px;margin-top:5px">stage: ${escapeHtml(v.stage)} · score ${v.score ?? 0}${v.revenue ? ` · $${Math.round(v.revenue)}` : ''}</div>
      <div class="dim" style="font-size:11px;margin-top:4px">${v.email ? '✉ has email' : v.phone ? '☎ phone only' : 'no contact'}</div>`;
  }
  const onMove = (e) => {
    pointerFrom(e);
    const i = hit();
    if (i !== hovered) {
      hovered = i;
      renderer.domElement.style.cursor = i >= 0 ? 'pointer' : 'grab';
      showHud(i);
    }
  };
  const onClick = (e) => {
    pointerFrom(e);
    const i = hit();
    if (i >= 0) onPick(pts[i]);
  };
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('click', onClick);

  // ── loop ──
  let raf, t0 = performance.now(), intro = 0;
  function frame() {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.05, (now - t0) / 1000); t0 = now;
    if (intro < 1) {
      intro = Math.min(1, intro + dt * 0.85);
      const e = 1 - Math.pow(1 - intro, 3);
      pts.forEach((v, i) => {
        const p = project(v.lat, v.lng);
        dummy.position.set(p.x, 0, p.z);
        dummy.scale.set(1.05, Math.max(0.01, heights[i] * e), 1.05);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
    }
    glowGroup.children.forEach((s, i) => {
      s.material.opacity = 0.22 + 0.12 * Math.sin(now / 900 + i);
    });
    controls.update();
    renderer.render(scene, camera);
  }
  frame();

  const onResize = () => {
    if (!container.clientWidth) return;
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  };
  window.addEventListener('resize', onResize);

  return {
    setMetric(m) {
      if (m === metric) return;
      opts.metric = m;
      dispose();
      return createVenueScene(container, venues, { ...opts, metric: m });
    },
    resetView() { camera.position.copy(home); camera.lookAt(controls.target); controls.update(); controls.autoRotate = true; },
    dispose,
  };

  function dispose() {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', onResize);
    renderer.domElement.removeEventListener('pointermove', onMove);
    renderer.domElement.removeEventListener('click', onClick);
    controls.dispose();
    geo.dispose(); mat.dispose();
    glowGroup.children.forEach(s => s.material.dispose());
    glowTex.dispose();
    renderer.dispose();
    container.innerHTML = '';
  }
}

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.28)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

"use client";

import { useEffect, useRef } from "react";

/**
 * Decorative three.js hero backdrop for the landing page.
 * three.js is imported lazily inside the effect so it never enters the
 * initial bundle; the scene pauses off-screen/hidden and honours
 * prefers-reduced-motion (renders a single static frame).
 */
export function MarketingHeroScene({ className = "" }: Readonly<{ className?: string }>) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let dispose: (() => void) | null = null;
    let cancelled = false;

    void createHeroScene(container).then((cleanup) => {
      if (cancelled) cleanup();
      else dispose = cleanup;
    });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  return <div ref={containerRef} className={`marketing-hero-3d ${className}`} aria-hidden="true" />;
}

/** Soft radial sprite used by the particle field (procedural — no asset download). */
function makeGlowTexture(): HTMLCanvasElement {
  const size = 64;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255, 244, 224, 0.9)");
  g.addColorStop(0.4, "rgba(255, 224, 190, 0.35)");
  g.addColorStop(1, "rgba(255, 224, 190, 0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/** Diagonal satin gradient used as the card face texture. */
function makeCardTexture(from: string, to: string): HTMLCanvasElement {
  const w = 256;
  const h = 160;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, from);
  g.addColorStop(1, to);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // subtle sheen band
  const sheen = ctx.createLinearGradient(0, 0, w, 0);
  sheen.addColorStop(0.25, "rgba(255,255,255,0)");
  sheen.addColorStop(0.5, "rgba(255,255,255,0.22)");
  sheen.addColorStop(0.75, "rgba(255,255,255,0)");
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, w, h);
  return canvas;
}

async function createHeroScene(container: HTMLDivElement): Promise<() => void> {
  const THREE = await import("three");
  const { RoundedBoxGeometry } = await import("three/examples/jsm/geometries/RoundedBoxGeometry.js");
  const { RoomEnvironment } = await import("three/examples/jsm/environments/RoomEnvironment.js");

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xf7f1ea, 10, 18);

  const camera = new THREE.PerspectiveCamera(
    38,
    container.clientWidth / Math.max(container.clientHeight, 1),
    0.1,
    40,
  );
  camera.position.set(0, 0.5, 8.5);

  // Image-based lighting for physical materials (reflections/"studio" sheen).
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTexture;

  // ── Lights: warm key with soft shadows + teal/amber rims ──
  const hemi = new THREE.HemisphereLight(0xfff4e0, 0xe8d9c4, 0.55);
  scene.add(hemi);

  const key = new THREE.DirectionalLight(0xfff1dc, 2.2);
  key.position.set(4, 6, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -7;
  key.shadow.camera.right = 7;
  key.shadow.camera.top = 6;
  key.shadow.camera.bottom = -6;
  key.shadow.bias = -0.0004;
  key.shadow.radius = 6;
  scene.add(key);

  const rimTeal = new THREE.PointLight(0x67a4b2, 22, 20);
  rimTeal.position.set(-6, 2.5, -2);
  scene.add(rimTeal);

  const rimAmber = new THREE.PointLight(0xe8b04b, 16, 18);
  rimAmber.position.set(5.5, -1.5, 2.5);
  scene.add(rimAmber);

  // ── Floating objects ──
  const disposables: { dispose(): void }[] = [envTexture];
  const group = new THREE.Group();
  scene.add(group);

  interface Floater {
    mesh: InstanceType<typeof THREE.Mesh>;
    baseY: number;
    speed: number;
    phase: number;
    spin: { x: number; y: number };
  }
  const floaters: Floater[] = [];

  const addFloater = (
    geometry: { dispose(): void },
    material: { dispose(): void },
    pos: [number, number, number],
    rot: [number, number, number],
    speed: number,
    spin: { x: number; y: number },
  ) => {
    const mesh = new THREE.Mesh(geometry as never, material as never);
    mesh.position.set(...pos);
    mesh.rotation.set(...rot);
    mesh.castShadow = true;
    group.add(mesh);
    disposables.push(geometry, material);
    floaters.push({ mesh, baseY: pos[1], speed, phase: Math.random() * Math.PI * 2, spin });
    return mesh;
  };

  const cardGeometry = () => new RoundedBoxGeometry(1.7, 1.05, 0.09, 4, 0.09);
  const cardMaterial = (from: string, to: string) => {
    const texture = new THREE.CanvasTexture(makeCardTexture(from, to));
    texture.colorSpace = THREE.SRGBColorSpace;
    disposables.push(texture);
    return new THREE.MeshPhysicalMaterial({
      map: texture,
      roughness: 0.24,
      metalness: 0.12,
      clearcoat: 1,
      clearcoatRoughness: 0.18,
      reflectivity: 0.9,
    });
  };

  // Brand-coloured "glass cards" — kept to the hero's edges/corners so the
  // copy zone (left-centre) stays clean; fog softens the deeper ones.
  addFloater(cardGeometry(), cardMaterial("#d7653c", "#b34a26"), [-5.5, 2.6, -3], [0.12, 0.45, -0.06], 0.7, { x: 0.05, y: 0.16 });
  addFloater(cardGeometry(), cardMaterial("#67a4b2", "#3f7d8c"), [2.5, 3.2, -4.5], [-0.1, -0.5, 0.08], 0.55, { x: -0.04, y: -0.12 });
  addFloater(cardGeometry(), cardMaterial("#f6ead9", "#e4cfae"), [-6, -2.6, -2], [-0.16, 0.35, 0.1], 0.8, { x: 0.06, y: 0.1 });

  // Gold coin + glossy accents
  const gold = new THREE.MeshPhysicalMaterial({
    color: 0xe8b04b,
    metalness: 1,
    roughness: 0.16,
    clearcoat: 0.6,
  });
  addFloater(new THREE.CylinderGeometry(0.55, 0.55, 0.12, 48), gold, [-3.6, -3.1, -1.5], [1.25, 0, 0.4], 0.9, { x: 0.02, y: 0.5 });

  const teal = new THREE.MeshPhysicalMaterial({ color: 0x67a4b2, metalness: 0.4, roughness: 0.1, clearcoat: 1 });
  addFloater(new THREE.SphereGeometry(0.34, 48, 32), teal, [1.4, 3.5, -3.5], [0, 0, 0], 1.1, { x: 0, y: 0 });

  const terra = new THREE.MeshPhysicalMaterial({ color: 0xd7653c, metalness: 0.75, roughness: 0.2 });
  addFloater(new THREE.TorusGeometry(0.5, 0.16, 24, 64), terra, [-6.5, 0.6, -3.5], [0.9, 0.2, 0], 0.65, { x: 0.1, y: 0.2 });

  // ── Soft contact shadows on an invisible floor ──
  const shadowMaterial = new THREE.ShadowMaterial({ opacity: 0.16 });
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), shadowMaterial);
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -2.9;
  floor.receiveShadow = true;
  scene.add(floor);
  disposables.push(floor.geometry, shadowMaterial);

  // ── Ambient particle field (warm bokeh dust) ──
  const particleCount = 130;
  const positions = new Float32Array(particleCount * 3);
  for (let i = 0; i < particleCount; i += 1) {
    positions[i * 3] = (Math.random() - 0.5) * 16;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 9;
    positions[i * 3 + 2] = -1 - Math.random() * 7;
  }
  const particleGeometry = new THREE.BufferGeometry();
  particleGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  const glowTexture = new THREE.CanvasTexture(makeGlowTexture());
  const particleMaterial = new THREE.PointsMaterial({
    map: glowTexture,
    size: 0.22,
    transparent: true,
    opacity: 0.8,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const particles = new THREE.Points(particleGeometry, particleMaterial);
  scene.add(particles);
  disposables.push(particleGeometry, particleMaterial, glowTexture);

  // ── Interaction + lifecycle ──
  const pointerTarget = { x: 0, y: 0 };
  const onPointerMove = (event: PointerEvent) => {
    pointerTarget.x = (event.clientX / window.innerWidth - 0.5) * 2;
    pointerTarget.y = (event.clientY / window.innerHeight - 0.5) * 2;
  };
  window.addEventListener("pointermove", onPointerMove, { passive: true });

  // Manual elapsed-time tracking (THREE.Clock is deprecated in r185).
  let elapsed = 0;
  let lastTick: number | null = null;
  let frameId = 0;
  let running = false;

  const renderFrame = () => {
    const nowMs = performance.now();
    if (lastTick !== null) elapsed += Math.min(nowMs - lastTick, 100) / 1000;
    lastTick = nowMs;
    const t = elapsed;
    for (const f of floaters) {
      f.mesh.position.y = f.baseY + Math.sin(t * f.speed + f.phase) * 0.28;
      f.mesh.rotation.x += f.spin.x * 0.004;
      f.mesh.rotation.y += f.spin.y * 0.004;
    }
    group.rotation.y = Math.sin(t * 0.08) * 0.06;
    particles.rotation.y = t * 0.012;
    camera.position.x += (pointerTarget.x * 0.45 - camera.position.x) * 0.03;
    camera.position.y += (0.5 - pointerTarget.y * 0.3 - camera.position.y) * 0.03;
    camera.lookAt(0, 0.2, -1.5);
    renderer.render(scene, camera);
  };

  const loop = () => {
    renderFrame();
    frameId = requestAnimationFrame(loop);
  };

  const start = () => {
    if (running || reducedMotion) return;
    running = true;
    lastTick = null;
    frameId = requestAnimationFrame(loop);
  };
  const stop = () => {
    if (!running) return;
    running = false;
    cancelAnimationFrame(frameId);
  };

  // Pause when the hero scrolls out of view or the tab is hidden.
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) start();
      else stop();
    },
    { threshold: 0.05 },
  );
  observer.observe(container);

  const onVisibility = () => {
    if (document.hidden) stop();
    else start();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const resizeObserver = new ResizeObserver(() => {
    const w = container.clientWidth;
    const h = Math.max(container.clientHeight, 1);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (reducedMotion) renderFrame();
  });
  resizeObserver.observe(container);

  // Reduced motion: draw one polished still frame instead of animating.
  renderFrame();

  return () => {
    stop();
    observer.disconnect();
    resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("pointermove", onPointerMove);
    for (const d of disposables) d.dispose();
    pmrem.dispose();
    renderer.dispose();
    renderer.domElement.remove();
  };
}

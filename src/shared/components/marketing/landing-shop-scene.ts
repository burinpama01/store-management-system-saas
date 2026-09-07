import * as THREE from "three";

export type ShopScene = { rotate: (direction: number) => void; pause: (paused: boolean) => void; dispose: () => void };

/** Small procedural scene: shared geometries, no image textures, no realtime shadows. */
export function createShopScene(container: HTMLDivElement): ShopScene {
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, window.innerWidth < 768 ? 1.25 : 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-4, 4, 3.5, -3.5, 0.1, 40);
  camera.position.set(6, 5, 8);
  camera.lookAt(0, 1, 0);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8b997a, 3));
  const light = new THREE.DirectionalLight(0xfff4df, 3);
  light.position.set(2, 6, 4);
  scene.add(light);
  const shop = new THREE.Group();
  scene.add(shop);

  const box = new THREE.BoxGeometry(1, 1, 1);
  const sphere = new THREE.SphereGeometry(1, 16, 12);
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, 24);
  const materials = {
    cream: new THREE.MeshStandardMaterial({ color: 0xfff5da, roughness: 0.7 }),
    orange: new THREE.MeshStandardMaterial({ color: 0xd55e39, roughness: 0.55 }),
    green: new THREE.MeshStandardMaterial({ color: 0x294f42, roughness: 0.65 }),
    glass: new THREE.MeshStandardMaterial({ color: 0x88b3a0, roughness: 0.25, metalness: 0.25 }),
    leaf: new THREE.MeshStandardMaterial({ color: 0x809a42, roughness: 0.85 }),
    gold: new THREE.MeshStandardMaterial({ color: 0xeeb94e, roughness: 0.3, metalness: 0.2 }),
    base: new THREE.MeshStandardMaterial({ color: 0xdfe5bd, roughness: 1 }),
  };
  type Color = keyof typeof materials;
  function block(color: Color, size: [number, number, number], pos: [number, number, number]) {
    const mesh = new THREE.Mesh(box, materials[color]);
    mesh.scale.set(...size);
    mesh.position.set(...pos);
    shop.add(mesh);
    return mesh;
  }
  function ball(color: Color, size: number, pos: [number, number, number]) {
    const mesh = new THREE.Mesh(sphere, materials[color]);
    mesh.scale.setScalar(size);
    mesh.position.set(...pos);
    shop.add(mesh);
    return mesh;
  }
  const plinth = new THREE.Mesh(cylinder, materials.base);
  plinth.scale.set(2.9, 0.22, 2.45);
  plinth.position.y = -0.05;
  shop.add(plinth);
  block("cream", [3, 2.25, 1.9], [0, 1.22, 0]);
  block("green", [3.18, 0.15, 2.06], [0, 2.42, 0]);
  block("orange", [3.28, 0.12, 2.12], [0, 2.54, 0]);
  // Front windows, inset door and pavement.
  block("green", [1.24, 1.12, 0.07], [-0.66, 1.16, 0.97]);
  block("glass", [1.06, 0.93, 0.08], [-0.66, 1.18, 1.01]);
  block("cream", [0.055, 1, 0.085], [-0.66, 1.18, 1.06]);
  block("green", [0.72, 1.7, 0.08], [0.77, 0.98, 0.98]);
  block("glass", [0.52, 1.09, 0.085], [0.77, 1.17, 1.025]);
  block("gold", [0.045, 0.18, 0.09], [1, 0.92, 1.085]);
  block("cream", [0.96, 0.12, 0.45], [0.77, 0.12, 1.17]);
  block("green", [0.07, 0.92, 1.22], [1.52, 1.3, 0]);
  block("glass", [0.08, 0.72, 1.04], [1.56, 1.3, 0]);
  // Shared instanced geometry for a striped awning (two draw calls).
  for (const color of ["orange", "cream"] as const) {
    const stripes = new THREE.InstancedMesh(box, materials[color], 5);
    const dummy = new THREE.Object3D();
    for (let i = 0; i < 5; i++) {
      dummy.position.set(-1.48 + (i * 2 + (color === "cream" ? 1 : 0)) * 0.33, 1.95, 1.18);
      dummy.scale.set(0.33, 0.14, 0.85);
      dummy.rotation.x = 0.22;
      dummy.updateMatrix();
      stripes.setMatrixAt(i, dummy.matrix);
    }
    shop.add(stripes);
  }
  block("green", [1.3, 0.4, 0.1], [0, 2.19, 1]);
  // Simple raised emblem instead of a texture download.
  const emblem = ball("gold", 0.13, [0, 2.19, 1.11]);
  emblem.scale.z = 0.22;
  for (const x of [-1.88, 1.95]) {
    block("orange", [0.4, 0.4, 0.4], [x, 0.29, 0.95]);
    ball("leaf", 0.4, [x, 0.76, 0.95]);
    ball("leaf", 0.29, [x - 0.14, 1.05, 0.93]);
  }
  block("green", [0.12, 0.77, 0.12], [-1.95, 0.47, -0.8]);
  ball("leaf", 0.56, [-1.95, 1.25, -0.8]);
  const coin = new THREE.Mesh(cylinder, materials.gold);
  coin.scale.set(0.37, 0.09, 0.37);
  coin.rotation.x = Math.PI / 2;
  coin.position.set(2.05, 2.82, 0.3);
  shop.add(coin);

  let angle = -0.12;
  let target = angle;
  let paused = false;
  let visible = false;
  let disposed = false;
  let frame = 0;
  let lastTime = 0;
  let elapsed = 0;
  let renderedFrames = 0;
  let measuredTime = 0;
  shop.rotation.y = angle;
  function render() {
    renderer.render(scene, camera);
    // Local QA can inspect actual renderer counters without exposing application data.
    container.dataset.drawCalls = String(renderer.info.render.calls);
    container.dataset.geometries = String(renderer.info.memory.geometries);
    container.dataset.textures = String(renderer.info.memory.textures);
  }
  function tick(time: number) {
    frame = 0;
    if (disposed || !visible || document.hidden || paused) return;
    if (time - lastTime >= 32) {
      const delta = Math.min((time - lastTime) / 1000, 0.1);
      lastTime = time;
      elapsed += delta;
      angle += (target - angle) * (1 - Math.exp(-6 * delta));
      shop.rotation.y = angle;
      coin.position.y = 2.82 + Math.sin(elapsed * 1.7) * 0.12;
      coin.rotation.z = Math.sin(elapsed * 0.8) * 0.2;
      render();
      renderedFrames++;
      measuredTime += delta;
      if (measuredTime >= 1) {
        container.dataset.fps = String(Math.round(renderedFrames / measuredTime));
        renderedFrames = 0;
        measuredTime = 0;
      }
    }
    frame = requestAnimationFrame(tick);
  }
  function sync() {
    cancelAnimationFrame(frame);
    frame = 0;
    container.dataset.animating = String(!disposed && visible && !document.hidden && !paused);
    if (!disposed && visible && !document.hidden && !paused) {
      lastTime = performance.now();
      frame = requestAnimationFrame(tick);
    }
  }
  function resize() {
    const width = Math.max(container.clientWidth, 1);
    const height = Math.max(container.clientHeight, 1);
    const aspect = width / height;
    const span = Math.max(3.15, 3.55 / aspect);
    camera.left = -span * aspect;
    camera.right = span * aspect;
    camera.top = span;
    camera.bottom = -span;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
    render();
  }
  const resizeObserver = new ResizeObserver(resize);
  const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
  const onContextLost = (event: Event) => {
    event.preventDefault();
    container.dispatchEvent(new Event("shop-scene-unavailable"));
  };
  renderer.domElement.addEventListener("webglcontextlost", onContextLost);
  document.addEventListener("visibilitychange", sync);
  container.appendChild(renderer.domElement);
  resizeObserver.observe(container);
  intersection.observe(container);
  resize();

  return {
    rotate(direction) {
      target = direction === 0 ? -0.12 : target + direction * Math.PI / 8;
      if (paused) { angle = target; shop.rotation.y = angle; render(); }
    },
    pause(value) { paused = value; sync(); },
    dispose() {
      disposed = true;
      sync();
      intersection.disconnect();
      resizeObserver.disconnect();
      document.removeEventListener("visibilitychange", sync);
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      box.dispose(); sphere.dispose(); cylinder.dispose();
      for (const material of Object.values(materials)) material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}

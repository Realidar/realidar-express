alert("JS conectado");
import * as THREE from './libs/three.module.js';
import { GLTFLoader } from './libs/GLTFLoader.js';

let camera, scene, renderer, controller;
let reticle, model;

// Función principal de inicialización
function initAR() {
  const container = document.createElement('div');
  document.body.appendChild(container);

  // Escena y cámara
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera();

  // Luz
  const light = new THREE.HemisphereLight(0xffffff, 0xbbbbff, 1);
  light.position.set(0.5, 1, 0.25);
  scene.add(light);

  // Renderer
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;
  container.appendChild(renderer.domElement);

  // Retícula (indicador del plano)
  const geometry = new THREE.RingGeometry(0.1, 0.15, 32).rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({ color: 0x00ffff });
  reticle = new THREE.Mesh(geometry, material);
  reticle.matrixAutoUpdate = false;
  reticle.visible = false;
  scene.add(reticle);

  // Cargar modelo GLB
  const loader = new GLTFLoader();
  loader.load('logo.glb', gltf => {
    model = gltf.scene;
    model.visible = false;
    scene.add(model);
  }, undefined, error => {
    console.error('Error al cargar modelo:', error);
  });

  // Controller XR para interacción
  controller = renderer.xr.getController(0);
  controller.addEventListener('select', () => {
    if (reticle.visible && model) {
      model.position.setFromMatrixPosition(reticle.matrix);
      model.visible = true;
    }
  });
  scene.add(controller);

  // Iniciar sesión XR
  document.body.appendChild(VRButton.createButton(renderer));
  renderer.setAnimationLoop(render);
}

// Render loop
function render(timestamp, frame) {
  if (frame) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    const session = renderer.xr.getSession();

    const viewerPose = frame.getViewerPose(referenceSpace);
    if (viewerPose) {
      const results = frame.getHitTestResultsForTransientInput?.(session.inputSources[0]);
      if (results && results.length > 0) {
        const hit = results[0];
        const pose = hit.inputSource.targetRaySpace;
        reticle.visible = true;
        reticle.matrix.fromArray(hit.getPose(referenceSpace).transform.matrix);
      }
    }
  }

  renderer.render(scene, camera);
}

// Evento para iniciar todo al presionar botón
document.getElementById('enter-ar').addEventListener('click', () => {
  document.querySelector('h1').remove();
  document.querySelector('p').remove();
  document.getElementById('enter-ar').remove();
  initAR();
});

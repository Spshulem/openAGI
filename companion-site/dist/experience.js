import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const canvas = document.getElementById('productCanvas');
const story = document.getElementById('experience');
const chapters = [...document.querySelectorAll('.chapter')];
const counter = document.getElementById('sceneCount');
const bar = document.getElementById('sceneProgress');
const labels = document.getElementById('openLabels');
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const mobile = matchMedia('(max-width: 700px)');
const clock = new THREE.Clock();
let phase = 0;
let shownScreen = -1;
let renderer, camera, scene, model, front, rear, inside, screenTexture;

const C = {
  shell: 0xc7bbaa, button: 0xc9bda9, violet: 0x7A3CFF, violetDeep: 0x6542A0,
  ink: 0x252420, glass: 0x101312, circuit: 0x214941,
  displayBoard: 0x292e2b, battery: 0x7d7c74, light: 0xb79aff,
};
function material(color, roughness = .58, metalness = 0) {
  return new THREE.MeshStandardMaterial({color, roughness, metalness});
}
const mats = {
  shell: material(C.shell, .68), button: material(C.button, .67), violet: material(C.violet, .58),
  deep: material(C.violetDeep, .59), ink: material(C.ink, .7),
  glass: material(C.glass, .26), circuit: material(C.circuit, .66),
  displayBoard: material(C.displayBoard, .6), battery: material(C.battery, .74),
  light: new THREE.MeshBasicMaterial({color:C.light}),
};
function box(parent, name, w, h, d, radius, x, y, z, mat) {
  const geometry = new RoundedBoxGeometry(w, h, d, 8, radius);
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = name;
  mesh.position.set(x,y,z);
  parent.add(mesh);
  return mesh;
}
function dot(parent, name, radius, x, y, z, mat) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius,radius,.0005,32),mat);
  mesh.name = name;
  mesh.rotation.x = Math.PI/2;
  mesh.position.set(x,y,z);
  parent.add(mesh);
  return mesh;
}
function makeDevice() {
  model = new THREE.Group();
  model.name = 'Pocket_v2_visual_study';
  front = new THREE.Group(); front.name = 'Front_Assembly';
  rear = new THREE.Group(); rear.name = 'Screw_Fastened_Rear';
  inside = new THREE.Group(); inside.name = 'Component_Envelope_Proxies';
  model.add(rear,inside,front);
  scene.add(model);

  // 58 x 55 x 23 mm compact target envelope, separated into serviceable halves.
  box(front,'Ivory_molded_front_shell',.058,.055,.0113,.008,0,0,.0058,mats.shell);
  box(rear,'Ivory_molded_rear_shell',.058,.055,.0113,.008,0,0,-.0058,mats.shell);
  box(rear,'Peripheral_split_line',.0567,.0537,.0005,.0075,0,0,0,mats.ink);

  // Ivory shell with a slim molded-purple lip around the display.
  box(front,'Violet_screen_lip',.047,.044,.0005,.006,0,0,.01166,mats.violet);
  box(front,'Dark_screen_gasket',.046,.043,.00045,.0057,0,0,.01199,mats.ink);
  box(front,'Tinted_screen_surround_not_active_display',.045,.042,.00035,.0054,0,0,.01225,mats.glass);
  box(front,'OLED_active_26_86mm',.02686,.02686,.0001,.0006,0,0,.01247,mats.glass);
  const surface = document.createElement('canvas');
  surface.width = surface.height = 512;
  screenTexture = new THREE.CanvasTexture(surface);
  screenTexture.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(.02686,.02686),
    new THREE.MeshBasicMaterial({map:screenTexture, transparent:true, depthWrite:false}));
  screen.name = 'OLED_dynamic_screen';
  screen.position.set(0,0,.01255);
  screen.renderOrder = 5;
  front.add(screen);

  // Status lamp, side press-to-talk, charging and microphones.
  box(front,'Status_lamp',.0035,.0008,.00045,.0004,-.020,.020,.0118,mats.light);
  box(front,'Side_push_to_talk',.0016,.012,.008,.0008,.0293,-.005,0,mats.violet);
  box(front,'USB_C_opening',.010,.0007,.0032,.00035,0,-.0275,0,mats.ink);
  [-.011,.011].forEach((x,i)=>dot(front,`Top_microphone_port_${i}`,.0007,x,.0275,.0001,mats.ink));

  // On the turned or exploded device, the fastening pattern is visible.
  box(rear,'Rear_access_panel',.048,.045,.0007,.006,0,0,-.012,mats.shell);
  for (const x of [-.020,.020]) for (const y of [-.018,.018])
    dot(rear,`Rear_screw_${x}_${y}`,.0017,x,y,-.0126,mats.ink);
  for (let i=0;i<6;i++) box(rear,`Speaker_port_${i}`,.001,.010,.00025,.0004,-.010+i*.004,-.003,-.0126,mats.ink);

  // Board dimensions come from the proposed purchasable modules; exact stack is unverified.
  box(inside,'Display_PCB_44_5x37mm',.0445,.037,.0014,.001,0,0,.0008,mats.displayBoard);
  box(inside,'XIAO_ESP32_S3_proxy_17_8x21mm',.0178,.021,.0015,.001,-.011,-.013,-.002,mats.circuit);
  box(inside,'Unselected_battery_30x20x6mm_proxy',.030,.020,.006,.002,0,.010,-.004,mats.battery);
}
function round(c,x,y,w,h,r) { c.beginPath(); c.roundRect(x,y,w,h,r); }
function screenState(index) {
  if (!screenTexture || shownScreen===index) return;
  shownScreen=index;
  const c=screenTexture.image.getContext('2d');
  c.clearRect(0,0,512,512);
  c.fillStyle='#101311'; round(c,0,0,512,512,27); c.fill();
  c.fillStyle='#f4eddf'; c.textAlign='center';
  c.font='600 21px Arial'; c.fillText('OPENAGI',256,63);
  c.fillStyle='#9b72ff'; c.beginPath(); c.arc(256,94,6,0,Math.PI*2); c.fill();
  c.fillStyle='#f4eddf';
  if(index===0){
    c.font='500 46px Arial'; c.fillText('Ready.',256,255);
    c.font='400 20px Arial'; c.fillText('PRESS TO TALK',256,428);
  } else if(index===1){
    c.font='500 39px Arial'; c.fillText('Listening',256,210);
    [19,31,50,85,111,74,44,28,16].forEach((h,i)=>{round(c,128+i*30,304-h/2,7,h,4);c.fill();});
    c.font='400 18px Arial'; c.fillText('RELEASE TO KEEP',256,430);
  } else if(index===2){
    c.font='500 42px Arial'; c.fillText('Captured.',256,230);
    c.font='400 24px Arial'; c.fillText('The thought is safe.',256,277);
    c.font='400 18px Arial'; c.fillText('10:41  ·  SAVED',256,428);
  } else if(index===3){
    c.font='500 35px Arial'; c.fillText('Send recap',256,214); c.fillText('to Maya?',256,260);
    c.strokeStyle='#f4eddf'; c.lineWidth=2; round(c,53,348,170,65,24); c.stroke();
    c.fillStyle='#f4eddf'; round(c,239,348,220,65,24); c.fill();
    c.font='500 22px Arial'; c.fillStyle='#f4eddf'; c.fillText('No',138,391);
    c.fillStyle='#101311'; c.fillText('Approve',349,391);
  } else {
    c.font='500 41px Arial'; c.fillText('Make it',256,236);
    c.fillText('yours.',256,282);
    c.font='400 18px Arial'; c.fillText('OPEN · REPLACE · BUILD',256,430);
  }
  screenTexture.needsUpdate=true;
}
function readScroll() {
  const rect=story.getBoundingClientRect();
  const vh=innerHeight;
  phase=THREE.MathUtils.clamp(-rect.top/vh,0,4);
  const active=Math.round(phase);
  screenState(active);
  counter.textContent=String(active+1).padStart(2,'0')+' / 05';
  bar.style.width=(phase/4*100)+'%';
  labels.classList.toggle('visible',phase>3.65);
  chapters.forEach((chapter,i)=>chapter.classList.toggle('current',i===active));
}
function resize() {
  if(!renderer) return;
  renderer.setSize(canvas.clientWidth,canvas.clientHeight,false);
  camera.aspect=canvas.clientWidth/canvas.clientHeight;
  camera.position.z=mobile.matches ? .28 : .225;
  camera.updateProjectionMatrix();
  readScroll();
}
function animate() {
  requestAnimationFrame(animate);
  const dt=Math.min(clock.getDelta(),.05);
  const ease=reduced.matches?1:1-Math.exp(-5*dt);
  const open=THREE.MathUtils.smoothstep(phase,3.35,4);
  const targetScale=(mobile.matches?.78:.97)*(1-open*.37);
  const targetX=mobile.matches?0:.027*(1-open);
  const targetY=mobile.matches?.012:0;
  const turn=THREE.MathUtils.lerp(-.26,.19,phase/4);
  model.rotation.x=THREE.MathUtils.lerp(model.rotation.x,.07,ease);
  model.rotation.y=THREE.MathUtils.lerp(model.rotation.y,turn,ease);
  model.rotation.z=THREE.MathUtils.lerp(model.rotation.z,-.035+phase*.012,ease);
  model.scale.setScalar(THREE.MathUtils.lerp(model.scale.x,targetScale,ease));
  model.position.x=THREE.MathUtils.lerp(model.position.x,targetX,ease);
  model.position.y=THREE.MathUtils.lerp(model.position.y,targetY,ease);
  front.position.x=THREE.MathUtils.lerp(front.position.x,-.047*open,ease);
  rear.position.x=THREE.MathUtils.lerp(rear.position.x,.047*open,ease);
  front.rotation.y=THREE.MathUtils.lerp(front.rotation.y,-.13*open,ease);
  rear.rotation.y=THREE.MathUtils.lerp(rear.rotation.y,.25*open,ease);
  renderer.render(scene,camera);
}
function init() {
  try {
    renderer=new THREE.WebGLRenderer({canvas,alpha:true,antialias:true,powerPreference:'high-performance'});
    renderer.setPixelRatio(Math.min(devicePixelRatio||1,2));
    renderer.outputColorSpace=THREE.SRGBColorSpace;
    renderer.toneMapping=THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure=1.45;
    scene=new THREE.Scene();
    camera=new THREE.PerspectiveCamera(27,1,.001,2);
    camera.position.set(0,0,.225);
    scene.add(new THREE.HemisphereLight(0xffffff,0x857a95,2.2));
    const key=new THREE.DirectionalLight(0xffffff,3.2); key.position.set(-.08,.12,.14); scene.add(key);
    const rim=new THREE.DirectionalLight(0xffffff,2.3); rim.position.set(.10,.04,-.08); scene.add(rim);
    makeDevice(); resize(); readScroll();
    model.rotation.set(.07,-.26,-.035);
    animate();
  } catch(error) {
    console.warn('Interactive model unavailable',error);
    canvas.hidden=true;
    document.getElementById('modelFallback').hidden=false;
  }
}
addEventListener('scroll',readScroll,{passive:true});
addEventListener('resize',resize);
init();

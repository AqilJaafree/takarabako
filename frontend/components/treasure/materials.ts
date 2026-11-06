import * as THREE from "three";

/// Custom GLSL for the two signature surfaces: urushi lacquer (deep red with a
/// sharp clearcoat highlight and a slow sheen sweeping across it) and gold
/// (warm fake-environment reflection with a fresnel rim). Lighting is baked
/// into the shaders — one key light in view space — so they look the same on
/// every device without an environment map to download.

const vertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vWorldPos;
  void main() {
    vec4 pos = vec4(position, 1.0);
    vec3 nrm = normal;
    #ifdef USE_INSTANCING
      pos = instanceMatrix * pos;
      nrm = mat3(instanceMatrix) * nrm;
    #endif
    vec4 world = modelMatrix * pos;
    vec4 view = viewMatrix * world;
    vWorldPos = world.xyz;
    vViewPos = view.xyz;
    vNormal = normalize(normalMatrix * nrm);
    gl_Position = projectionMatrix * view;
  }
`;

const lacquerFragment = /* glsl */ `
  uniform float uTime;
  uniform vec3 uDeep;
  uniform vec3 uRed;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vWorldPos;
  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(-vViewPos);
    vec3 L = normalize(vec3(0.45, 0.85, 0.55));
    float diff = max(dot(N, L), 0.0);
    vec3 base = mix(uDeep, uRed, 0.25 + 0.75 * diff);
    // Clearcoat: a tight, bright highlight over a softer one.
    vec3 R = reflect(-L, N);
    float coat = pow(max(dot(R, V), 0.0), 80.0);
    float soft = pow(max(dot(R, V), 0.0), 12.0);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 3.0);
    // Slow diagonal sheen, like light moving across polished urushi.
    float band = smoothstep(0.0, 0.25, 0.25 - abs(fract((vWorldPos.x + vWorldPos.y) * 0.18 - uTime * 0.06) - 0.5));
    vec3 col = base
      + coat * vec3(1.0, 0.93, 0.85)
      + soft * vec3(0.55, 0.18, 0.12) * 0.35
      + fres * vec3(0.95, 0.55, 0.4) * 0.35
      + band * vec3(1.0, 0.8, 0.6) * 0.07;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const goldFragment = /* glsl */ `
  uniform float uTime;
  uniform float uGlow;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vWorldPos;
  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(-vViewPos);
    vec3 L = normalize(vec3(0.45, 0.85, 0.55));
    // Fake studio environment: dark below the horizon, bright above.
    vec3 Rv = reflect(-V, N);
    float horizon = smoothstep(-0.25, 0.7, Rv.y);
    vec3 env = mix(vec3(0.30, 0.16, 0.04), vec3(1.0, 0.86, 0.56), horizon);
    float spec = pow(max(dot(reflect(-L, N), V), 0.0), 40.0);
    float fres = pow(1.0 - max(dot(N, V), 0.0), 2.5);
    float shimmer = 0.5 + 0.5 * sin(uTime * 2.0 + vWorldPos.x * 6.0 + vWorldPos.z * 4.0);
    vec3 col = env * (0.55 + 0.45 * max(dot(N, L), 0.0))
      + spec * vec3(1.0, 0.95, 0.8)
      + fres * vec3(1.0, 0.8, 0.45) * 0.45
      + shimmer * 0.04
      + uGlow * vec3(0.9, 0.6, 0.2);
    gl_FragColor = vec4(col, 1.0);
  }
`;

export function createLacquer() {
  return new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: lacquerFragment,
    uniforms: {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color("#3a0906") },
      uRed: { value: new THREE.Color("#b3261e") },
    },
  });
}

export function createGold() {
  return new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: goldFragment,
    uniforms: { uTime: { value: 0 }, uGlow: { value: 0 } },
  });
}

const marbleFragment = /* glsl */ `
  uniform float uTime;
  uniform float uGlow;
  uniform float uLit;
  varying vec3 vNormal;
  varying vec3 vViewPos;
  varying vec3 vWorldPos;
  float hash(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float noise(vec3 p) {
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x), mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
               mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x), mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
  }
  void main() {
    vec3 N = normalize(vNormal);
    vec3 V = normalize(-vViewPos);
    vec3 L = normalize(vec3(0.45, 0.85, 0.55));
    float diff = max(dot(N, L), 0.0);
    // White marble with faint grey veins.
    float n = noise(vWorldPos * 6.0) * 0.6 + noise(vWorldPos * 14.0) * 0.4;
    float vein = smoothstep(0.48, 0.5, abs(sin(vWorldPos.x * 3.0 + vWorldPos.y * 5.0 + n * 6.0)) * 0.5);
    vec3 marble = mix(vec3(0.93, 0.91, 0.95), vec3(0.78, 0.76, 0.84), vein * 0.35);
    // Moonlit purple from above, warm diya light from below (stronger as the balance grows).
    vec3 sky = vec3(0.62, 0.5, 0.95);
    vec3 warm = vec3(1.0, 0.62, 0.28);
    float below = pow(clamp(1.0 - vWorldPos.y * 1.6, 0.0, 1.0), 2.0);
    vec3 col = marble * (0.32 + 0.58 * diff) * mix(vec3(1.0), sky, 0.3)
      + marble * warm * below * (0.06 + 0.32 * uLit)
      + pow(1.0 - max(dot(N, V), 0.0), 3.0) * sky * 0.35
      + pow(max(dot(reflect(-L, N), V), 0.0), 30.0) * 0.25
      + uGlow * warm * 0.35;
    gl_FragColor = vec4(col, 1.0);
  }
`;

/// The Taj Mahal's white marble: faint veins, lit purple from above and warm
/// from the diyas below. uLit (0–1) follows the balance; uGlow flashes on a deposit.
export function createMarble() {
  return new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: marbleFragment,
    uniforms: { uTime: { value: 0 }, uGlow: { value: 0 }, uLit: { value: 0 } },
  });
}

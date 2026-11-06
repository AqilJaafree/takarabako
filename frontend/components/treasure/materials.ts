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

/// Red urushi by default; the Deepavali plinth passes royal blue.
export function createLacquer(deep = "#3a0906", lit = "#b3261e") {
  return new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: lacquerFragment,
    uniforms: {
      uTime: { value: 0 },
      uDeep: { value: new THREE.Color(deep) },
      uRed: { value: new THREE.Color(lit) },
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

const giltFragment = /* glsl */ `
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
    // Fake environment: dark bronze below the horizon, warm gold above, a little
    // royal-blue night sky straight up.
    vec3 Rv = reflect(-V, N);
    float horizon = smoothstep(-0.3, 0.6, Rv.y);
    vec3 env = mix(vec3(0.24, 0.12, 0.04), vec3(1.0, 0.8, 0.45), horizon);
    env = mix(env, vec3(0.45, 0.5, 1.0), smoothstep(0.75, 1.0, Rv.y) * 0.35);
    // Fine chased lines in the gold, like engraved leaf.
    float n = noise(vWorldPos * 7.0) * 0.6 + noise(vWorldPos * 16.0) * 0.4;
    float chase = smoothstep(0.492, 0.5, abs(sin(vWorldPos.x * 4.0 + vWorldPos.y * 6.0 + n * 7.0)) * 0.5);
    vec3 gilt = env * (0.5 + 0.5 * diff) * (1.0 - chase * 0.12);
    // Warm diya light from below, stronger as the balance grows.
    float below = pow(clamp(1.0 - vWorldPos.y * 1.6, 0.0, 1.0), 2.0);
    vec3 warm = vec3(1.0, 0.62, 0.28);
    float sweep = smoothstep(0.0, 0.2, 0.2 - abs(fract((vWorldPos.x + vWorldPos.y) * 0.22 - uTime * 0.08) - 0.5));
    vec3 col = gilt
      + gilt * warm * below * (0.1 + 0.4 * uLit)
      + pow(max(dot(reflect(-L, N), V), 0.0), 36.0) * vec3(1.0, 0.95, 0.8) * 0.8
      + pow(1.0 - max(dot(N, V), 0.0), 2.5) * vec3(1.0, 0.78, 0.4) * 0.35
      + sweep * vec3(1.0, 0.9, 0.65) * 0.12
      + uGlow * warm * 0.4;
    gl_FragColor = vec4(col, 1.0);
  }
`;

/// The Deepavali palace's gilding: chased gold with a slow sheen moving across
/// it, warmed from the diyas below. uLit (0–1) follows the balance; uGlow
/// flashes on a deposit.
export function createGilt() {
  return new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: giltFragment,
    uniforms: { uTime: { value: 0 }, uGlow: { value: 0 }, uLit: { value: 0 } },
  });
}

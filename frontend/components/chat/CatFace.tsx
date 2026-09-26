/// Maneki's face for the chat transition: the same stylized maneki-neko as
/// the 3D scene (white fur, pink ears, black eyes, red collar, gold bell),
/// drawn in SVG so it can fill the screen and open its mouth. `mouth` is
/// 0 (closed) to 1 (wide open), driven by CSS.

export function CatFace({ className = "" }: { className?: string }) {
  return (
    <svg className={`cat-face ${className}`} viewBox="0 0 400 400" aria-hidden="true">
      {/* ears */}
      <path d="M78 150 L96 42 L176 104 Z" fill="#fbf5ec" />
      <path d="M322 150 L304 42 L224 104 Z" fill="#fbf5ec" />
      <path d="M98 128 L108 70 L156 106 Z" fill="#f3a6a0" />
      <path d="M302 128 L292 70 L244 106 Z" fill="#f3a6a0" />
      {/* head */}
      <ellipse cx="200" cy="210" rx="160" ry="140" fill="#fbf5ec" />
      <ellipse cx="200" cy="232" rx="118" ry="96" fill="#fffdf8" opacity="0.7" />
      {/* eyes */}
      <g className="cat-eyes">
        <ellipse cx="138" cy="196" rx="22" ry="28" fill="#241512" />
        <ellipse cx="262" cy="196" rx="22" ry="28" fill="#241512" />
        <circle cx="146" cy="184" r="8" fill="#fff" />
        <circle cx="270" cy="184" r="8" fill="#fff" />
        <circle cx="132" cy="206" r="3.5" fill="#fff" opacity="0.8" />
        <circle cx="256" cy="206" r="3.5" fill="#fff" opacity="0.8" />
      </g>
      {/* cheeks */}
      <ellipse cx="100" cy="246" rx="24" ry="13" fill="#f3a6a0" opacity="0.6" />
      <ellipse cx="300" cy="246" rx="24" ry="13" fill="#f3a6a0" opacity="0.6" />
      {/* nose */}
      <path d="M186 232 Q200 226 214 232 L200 246 Z" fill="#f08b86" />
      {/* mouth: closed smile, and the opening (scaled by CSS) */}
      <path className="cat-smile" d="M170 262 Q185 276 200 262 Q215 276 230 262" stroke="#8a5a50" strokeWidth="4" fill="none" strokeLinecap="round" />
      <g className="cat-mouth">
        <ellipse cx="200" cy="286" rx="46" ry="40" fill="#3a0906" />
        <ellipse cx="200" cy="306" rx="28" ry="16" fill="#e8807a" />
        <path d="M168 262 L176 280 L184 262 Z M216 262 L224 280 L232 262 Z" fill="#fff" />
      </g>
      {/* collar and bell */}
      <path d="M72 318 Q200 372 328 318 L322 342 Q200 396 78 342 Z" fill="#b3261e" />
      <circle cx="200" cy="364" r="16" fill="#e3b36a" />
      <circle cx="194" cy="358" r="5" fill="#fff4dc" opacity="0.8" />
      {/* paws, raised toward the viewer during the transition */}
      <g className="cat-paws">
        <ellipse cx="96" cy="380" rx="46" ry="38" fill="#fbf5ec" />
        <ellipse cx="304" cy="380" rx="46" ry="38" fill="#fbf5ec" />
        <ellipse cx="84" cy="372" rx="9" ry="7" fill="#f3a6a0" />
        <ellipse cx="108" cy="372" rx="9" ry="7" fill="#f3a6a0" />
        <ellipse cx="292" cy="372" rx="9" ry="7" fill="#f3a6a0" />
        <ellipse cx="316" cy="372" rx="9" ry="7" fill="#f3a6a0" />
      </g>
    </svg>
  );
}

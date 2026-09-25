// Animated wallpaper behind the glass panels. Loaded by nav.js.
//
// Shaders ported from the WebKit animated-backgrounds kit, one per theme
// (Settings > General > Theme). The default theme pairs two of them:
//   dark  -> Silk Flow (soft folds drifting sideways, blue/violet/teal)
//   light -> Opal Film (pastel thin-film iridescence, leans with the pointer)
// The others run one shader in both modes. They were drawn for a dark
// canvas, so in light mode finish() lays their colour over pale paper
// instead of adding it to black.
//
// Everything sits behind frosted glass, so it renders at half resolution and
// 30fps, stops when the window is hidden, and draws one still frame when the
// OS asks for reduced motion. If WebGL is unavailable the static webp from
// glass.css stays in place.
//
// Settings > General > Animated background. Off freezes the shader at the
// moment it was switched off; that moment is kept in localStorage so every
// page shows the same still frame, and the storage event carries a change to
// pages that are already open. The chosen theme travels the same way.
(() => {
  const HEAD = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform float uTime;
uniform float uSpeed;
uniform float uLight;
uniform vec3 uBg;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<4;i++){v+=a*noise(p);p*=2.03;a*=0.5;}return v;}
float grain(){return hash(gl_FragCoord.xy+floor(uTime*5.0)*vec2(13.7,7.3));}
vec3 finish(vec3 c){
  if(uLight<0.5) return uBg+c;
  float m=max(max(c.r,c.g),c.b);
  vec3 hue=c/max(m,1e-3);
  return mix(uBg,mix(hue,vec3(1.0),0.22),clamp(m*0.9,0.0,0.85));
}
`;

  const SILK = HEAD + `
uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes; uv.y=1.0-uv.y;
  float s=uTime*uSpeed;
  float n1=fbm(vec2(uv.x*1.8-s*0.10,uv.y*5.0));
  float n2=fbm(vec2(uv.x*3.1-s*0.16+17.0,uv.y*7.0+3.0));
  float v=uv.y*2.6+0.35*sin(uv.x*3.6-s*0.40+n1*2.6)+0.22*sin(uv.x*6.8-s*0.25+n2*3.0)+(n1-0.5)*0.9;
  float fold=0.5+0.5*sin(v*6.2831);
  float body=pow(fold,1.8), sheen=pow(fold,7.0);
  float m=clamp(uv.x+(n2-0.5)*0.4,0.0,1.0);
  vec3 base=mix(uC0,uC1,smoothstep(0.15,0.60,m));
  base=mix(base,uC2,smoothstep(0.60,1.0,m)*0.85);
  vec3 col=base*body*(0.45+0.55*n1);
  col+=(base*0.4+vec3(0.6))*sheen*0.35;
  col*=smoothstep(0.0,0.18,uv.y)*smoothstep(1.0,0.82,uv.y);
  col=1.0-exp(-col*1.6);
  float gr=grain();
  col*=0.92+0.16*gr; col+=(gr-0.5)*0.03;
  gl_FragColor=vec4(finish(col),1.0);
}`;

  // Already a light-mode shader (pastel over black), so no finish().
  const OPAL = HEAD + `
uniform vec2 uMouse; uniform vec3 uC0;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes-0.5; uv.x*=uRes.x/uRes.y;
  float s=uTime*uSpeed;
  vec2 p=uv+(uMouse-0.5)*0.18;
  vec2 q=vec2(fbm(p*1.1+vec2(0.0,s*0.05)),fbm(p*1.1+vec2(5.2,-s*0.04)));
  float v=fbm(p*1.3+1.6*q+vec2(s*0.06,-s*0.03));
  float t=fract(v*1.6+p.x*0.05);
  vec3 A=vec3(0.45,0.62,0.95),B=vec3(0.45,0.85,0.85),C=vec3(0.62,0.5,0.95),D=vec3(0.95,0.62,0.85);
  float tt=t*4.0;
  vec3 fr=tt<1.0?mix(A,B,tt):tt<2.0?mix(B,C,tt-1.0):tt<3.0?mix(C,D,tt-2.0):mix(D,A,tt-3.0);
  vec3 col=mix(fr,vec3(1.0),0.3)*uC0*2.0;
  col=1.0-exp(-col*1.6);
  float gr=grain();
  col*=0.95+0.1*gr; col+=(gr-0.5)*0.015;
  gl_FragColor=vec4(uBg+col,1.0);
}`;

  // Aurora Spire: a slow column of light climbing the frame, veils rising inside.
  const AURORA = HEAD + `
uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec2 p=vec2((uv.x-0.5)*(uRes.x/uRes.y),uv.y);
  float s=uTime*uSpeed;
  float axis=(uv.y-0.5)*0.22+0.12*(fbm(vec2(uv.y*1.6,s*0.07))-0.5);
  float dx=p.x-axis;
  float wdt=0.2+0.08*fbm(vec2(uv.y*2.2+7.0,s*0.06));
  float column=exp(-pow(dx/wdt,2.0));
  vec2 q=vec2(dx*3.0+uv.y*1.4+s*0.18,uv.y*1.3-s*0.28);
  float warp=fbm(q*1.6+vec2(0.0,s*0.05));
  float veil=fbm(q*2.1+vec2(warp*1.7,-warp*0.5));
  veil=pow(smoothstep(0.3,0.85,veil),1.7);
  float wisp=fbm(vec2(dx*6.5-uv.y*2.0-s*0.1,uv.y*3.2-s*0.5));
  wisp=pow(smoothstep(0.5,0.9,wisp),2.0)*0.6;
  float i=column*(veil+wisp)+column*column*0.12;
  vec3 tint=mix(uC1,uC0,smoothstep(0.05,0.95,uv.y));
  vec3 col=tint*i*1.6+uC2*pow(i,3.0)*0.45;
  col=1.0-exp(-col*1.7);
  float gr=grain();
  col*=0.93+0.14*gr; col+=(gr-0.5)*0.025;
  gl_FragColor=vec4(finish(col),1.0);
}`;

  // Marble Flux: glossy folds kneading themselves; fbm warped by fbm warped by fbm.
  const MARBLE = HEAD + `
uniform vec3 uC0;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes-0.5; uv.x*=uRes.x/uRes.y;
  float s=uTime*uSpeed;
  vec2 p=uv*1.15;
  vec2 q1=vec2(fbm(p+vec2(0.0,s*0.1)),fbm(p+vec2(5.2,1.3)-vec2(s*0.08,0.0)));
  vec2 q2=vec2(fbm(p+2.2*q1+vec2(1.7,9.2)+vec2(s*0.12,0.0)),fbm(p+2.2*q1+vec2(8.3,2.8)-vec2(0.0,s*0.09)));
  float v=fbm(p+2.4*q2);
  float m=0.5+0.5*sin(v*11.0+s*0.4);
  m=pow(smoothstep(0.15,0.9,m),1.6);
  float sheen=pow(0.5+0.5*sin(v*22.0+1.3),12.0)*0.5;
  vec3 col=uC0*m*0.9+vec3(1.0)*(pow(m,4.0)*0.15+sheen*m*0.6);
  col=1.0-exp(-col*1.9);
  float gr=grain();
  col*=0.93+0.14*gr; col+=(gr-0.5)*0.025;
  gl_FragColor=vec4(finish(col),1.0);
}`;

  // Mercury Veins: liquid metal; the pointer leans the fluid and ripples it.
  const MERCURY = HEAD + `
uniform vec2 uMouse; uniform vec3 uC0;
void main(){
  float mn=min(uRes.x,uRes.y);
  vec2 uv=(2.0*gl_FragCoord.xy-uRes)/mn;
  float s=uTime*uSpeed;
  vec2 m=(uMouse-0.5)*2.0;
  vec2 p=uv+m*0.3;
  mat2 R=mat2(0.96,-0.28,0.28,0.96);
  for(int i=1;i<=3;i++){
    float fi=float(i);
    p.x+=0.34/fi*cos(fi*2.1*p.y+s*0.6+1.7);
    p.y+=0.34/fi*sin(fi*1.6*p.x-s*0.45+4.1);
    p=R*p;
  }
  vec2 d=uv-m; float dist=length(d);
  p+=(d/(dist+1e-3))*sin(dist*18.0-s*2.2)*exp(-dist*7.0)*0.06;
  float i1=0.085/(abs(sin(p.x+p.y-s*0.35))+0.07);
  float i2=0.035/(abs(sin(p.x-p.y*0.7+s*0.27+2.0))+0.08);
  vec3 col=uC0*(i1+i2*0.6)*0.7;
  col=1.0-exp(-col*1.9);
  float gr=grain();
  col*=0.94+0.12*gr; col+=(gr-0.5)*0.02;
  gl_FragColor=vec4(finish(col),1.0);
}`;

  // Dawn Current: one soft current of light flowing across mid-frame.
  const DAWN = HEAD + `
uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2;
vec3 palette(float t){return mix(mix(uC0,uC1,smoothstep(0.0,0.55,t)),uC2,smoothstep(0.5,1.0,t));}
float current(vec2 p,float seed,float s){
  float wave=(fbm(vec2(p.x*0.9+seed,s*0.1+seed*2.0))-0.5)*0.45+0.08*sin(p.x*2.2+seed*3.0+s*0.2);
  float m=abs(p.y-wave);
  float spread=0.08+0.06*fbm(vec2(p.x*0.7+seed*5.0,s*0.08));
  return exp(-pow(m/spread,1.6))*0.85;
}
void main(){
  vec2 uv=gl_FragCoord.xy/uRes-0.5; uv.x*=uRes.x/uRes.y;
  float s=uTime*uSpeed;
  vec3 col=palette(0.5+0.5*sin(uv.x*1.4+s*0.16))*current(uv,1.7,s);
  col+=palette(0.5+0.5*sin(uv.x*1.1-s*0.11+2.0))*current(uv,6.3,s+3.0)*0.6;
  col=1.0-exp(-col*1.6);
  float gr=grain();
  col*=0.93+0.14*gr; col+=(gr-0.5)*0.025;
  gl_FragColor=vec4(finish(col),1.0);
}`;

  // Vapor Ribbons: wide misty bands snaking across the frame, one colour each.
  const VAPOR = HEAD + `
uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2;
float ribbon(vec2 p,float base,float seed,float s){
  float path=base+0.14*sin(p.x*1.3+seed+s*0.14)+0.06*sin(p.x*2.9-seed*2.0-s*0.09)
    +0.16*(fbm(vec2(p.x*0.55+seed*3.0,s*0.05))-0.5);
  float m=abs(p.y-path);
  float wdt=0.04+0.03*fbm(vec2(p.x*1.1+seed*7.0,s*0.07));
  return exp(-pow(m/wdt,2.0))+exp(-pow(m/(wdt*4.0),2.0))*0.18;
}
void main(){
  vec2 uv=gl_FragCoord.xy/uRes-0.5; uv.x*=uRes.x/uRes.y;
  float s=uTime*uSpeed;
  float a=-0.14;
  vec2 p=mat2(cos(a),-sin(a),sin(a),cos(a))*uv;
  vec3 col=uC0*ribbon(p,0.26,1.7,s)*0.65+uC1*ribbon(p,-0.04,4.9,s)*0.75+uC2*ribbon(p,-0.34,8.3,s)*0.5;
  col=1.0-exp(-col*1.7);
  float gr=grain();
  col*=0.93+0.14*gr; col+=(gr-0.5)*0.025;
  gl_FragColor=vec4(finish(col),1.0);
}`;

  // Velvet Sweep: one curved ribbon of glowing cloth, most of the frame left dark.
  const VELVET = HEAD + `
uniform vec3 uC0;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec2 p=vec2((uv.x-0.5)*(uRes.x/uRes.y),uv.y-0.5);
  float s=uTime*uSpeed;
  vec2 d=p-vec2(0.85,0.55);
  float r=length(d), ang=atan(d.y,d.x);
  float dist=r-(1.05+(fbm(vec2(ang*2.0+3.0,s*0.06))-0.5)*0.3);
  float wdt=0.2+0.12*fbm(vec2(ang*1.6+9.0,s*0.05));
  float band=exp(-pow(dist/wdt,2.0));
  float ends=smoothstep(-3.35,-2.9,ang)*smoothstep(-1.8,-2.35,ang);
  float silk=fbm(vec2(ang*3.0,dist*6.0)+s*0.08);
  float folds=pow(smoothstep(0.1,0.95,0.5+0.5*sin(dist*13.0+silk*3.5-s*0.45)),1.3);
  float i=band*ends*(0.25+0.75*folds);
  vec3 col=uC0*i*1.15+vec3(1.0)*pow(i,4.0)*0.12;
  col=1.0-exp(-col*1.8);
  float gr=grain();
  col*=0.93+0.14*gr; col+=(gr-0.5)*0.025;
  gl_FragColor=vec4(finish(col),1.0);
}`;

  // A shader and its uniforms per mode. Strings are vec3 colours, numbers
  // floats. The names must match general.background in lib/settings.mjs.
  const DARK = '#0b0e14', PAPER = '#eef1f7';
  // `light` holds colours that read better over paper.
  const both = (frag, { light = {}, ...u }, extra = {}) => ({
    dark:  { frag, u: { ...u, uBg: DARK }, ...extra },
    light: { frag, u: { ...u, ...light, uBg: PAPER, uLight: 1 }, ...extra },
  });
  const THEMES = {
    default: {
      dark:  { frag: SILK, u: { uC0: '#2f4fd0', uC1: '#6d4ee6', uC2: '#178fa3', uBg: DARK, uSpeed: 0.6 } },
      light: { frag: OPAL, u: { uC0: '#8a9fd6', uBg: '#000000', uSpeed: 0.7 }, mouse: true },
    },
    aurora:  both(AURORA,  { uC0: '#6d4df2', uC1: '#f27dd7', uC2: '#f4ecff', uSpeed: 0.7, light: { uC2: '#b58cf0' } }),
    marble:  both(MARBLE,  { uC0: '#0e6d67', uSpeed: 0.45, light: { uC0: '#1fa39a' } }),
    mercury: both(MERCURY, { uC0: '#dfe3ee', uSpeed: 0.6, light: { uC0: '#3f64d8' } }, { mouse: true }),
    dawn:    both(DAWN,    { uC0: '#5b8af2', uC1: '#a86df2', uC2: '#f25b9e', uSpeed: 0.8 }),
    vapor:   both(VAPOR,   { uC0: '#2fb5c9', uC1: '#3b6cf6', uC2: '#5fd6a0', uSpeed: 0.8 }),
    velvet:  both(VELVET,  { uC0: '#e8603c', uSpeed: 0.7 }),
  };

  const SCALE = 0.5, FPS = 30;
  const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
  const modeNow = () => document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
  // This browser's copy of the theme draws the first frame; the saved
  // setting (fetched below) wins if they differ.
  const THEME_KEY = 'bgTheme';
  const readTheme = () => {
    try { const v = localStorage.getItem(THEME_KEY); return v && v in THEMES ? v : 'default'; } catch { return 'default'; }
  };

  function init() {
    const canvas = document.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:-1;pointer-events:none;opacity:0;transition:opacity .6s';
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
    if (!gl) return;
    document.body.prepend(canvas);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const compile = (type, src) => {
      const sh = gl.createShader(type);
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) { console.error('bg shader:', gl.getShaderInfoLog(sh)); return null; }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, 'attribute vec2 aPos;void main(){gl_Position=vec4(aPos,0.0,1.0);}');
    // Compiled on first use: a page usually needs one shader, two at most.
    const progs = new Map();
    const program = (frag) => {
      if (progs.has(frag)) return progs.get(frag);
      let entry = null;
      const fs = vs && compile(gl.FRAGMENT_SHADER, frag);
      if (fs) {
        const p = gl.createProgram();
        gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
        if (gl.getProgramParameter(p, gl.LINK_STATUS)) {
          entry = { p, uRes: gl.getUniformLocation(p, 'uRes'), uTime: gl.getUniformLocation(p, 'uTime'),
                    uMouse: gl.getUniformLocation(p, 'uMouse') };
        }
      }
      progs.set(frag, entry);
      return entry;
    };

    let cur = null, themeName = readTheme();
    const use = () => {
      const t = THEMES[themeName][modeNow()];
      const pr = t && program(t.frag);
      cur = pr ? { ...pr, mouse: !!t.mouse } : null;
      canvas.style.opacity = cur ? '1' : '0';
      if (!cur) return;
      gl.useProgram(cur.p);
      const a = gl.getAttribLocation(cur.p, 'aPos');
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
      gl.uniform1f(gl.getUniformLocation(cur.p, 'uLight'), 0);
      gl.uniform1f(gl.getUniformLocation(cur.p, 'uSpeed'), 1);
      for (const [k, v] of Object.entries(t.u)) {
        const loc = gl.getUniformLocation(cur.p, k);
        if (typeof v === 'number') gl.uniform1f(loc, v);
        else if (typeof v === 'string') gl.uniform3f(loc, ...rgb(v));
      }
    };

    // Wall-clock time, so the pattern carries on across page navigations
    // instead of restarting on every click in the sidebar.
    const clock = () => (Date.now() / 1000) % 86400;
    // null = animating; a number = frozen at that clock time.
    const KEY = 'animBgFrozenAt';
    const readFrozen = () => {
      try { const v = localStorage.getItem(KEY); return v == null ? null : Number(v) || 0; } catch { return null; }
    };
    let frozenAt = readFrozen();
    const now = () => (frozenAt == null ? clock() : frozenAt);
    let mx = 0.5, my = 0.5, tx = 0.5, ty = 0.5;
    addEventListener('pointermove', (e) => { tx = e.clientX / innerWidth; ty = 1 - e.clientY / innerHeight; }, { passive: true });

    const draw = () => {
      if (!cur) return;
      gl.uniform2f(cur.uRes, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.uniform1f(cur.uTime, now());
      if (cur.mouse) { mx += (tx - mx) * 0.08; my += (ty - my) * 0.08; gl.uniform2f(cur.uMouse, mx, my); }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const resize = () => {
      canvas.width = Math.max(1, Math.round(innerWidth * SCALE));
      canvas.height = Math.max(1, Math.round(innerHeight * SCALE));
      gl.viewport(0, 0, canvas.width, canvas.height);
      draw();
    };

    const still = matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0, last = 0;
    const frame = (t) => {
      raf = requestAnimationFrame(frame);
      if (t - last < 1000 / FPS) return;
      last = t; draw();
    };
    // Frozen still follows the pointer on pointer shaders; only time stops.
    const moving = () => frozenAt == null || !!cur?.mouse;
    const start = () => { if (!raf && !document.hidden && !still.matches && moving()) raf = requestAnimationFrame(frame); };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    const applyFrozen = (v) => { frozenAt = v; stop(); draw(); start(); };
    const retheme = () => { use(); stop(); draw(); start(); };
    const applyTheme = (name) => { themeName = name in THEMES ? name : 'default'; retheme(); };

    window.switchboardBg = {
      set(on) {
        const v = on ? null : now();
        try { on ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, String(v)); } catch {}
        applyFrozen(v);
      },
      theme(name) {
        try { name === 'default' ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, name); } catch {}
        applyTheme(name);
      },
    };
    addEventListener('storage', (e) => {
      if (e.key === KEY || e.key === null) applyFrozen(readFrozen());
      if (e.key === THEME_KEY || e.key === null) applyTheme(readTheme());
    });
    // The saved setting wins over this browser's copy (e.g. after Reset).
    fetch('/api/settings').then(r => (r.ok ? r.json() : null)).then(j => {
      const g = j?.settings?.general || {};
      if (typeof g.background === 'string' && g.background !== themeName) window.switchboardBg.theme(g.background);
      const on = g.animatedBackground;
      if (typeof on === 'boolean' && on !== (frozenAt == null)) window.switchboardBg.set(on);
    }).catch(() => {});

    use(); resize(); start();
    addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
    still.addEventListener?.('change', () => { stop(); draw(); start(); });
    new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    matchMedia('(prefers-color-scheme:dark)').addEventListener?.('change', retheme);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); canvas.style.opacity = '0'; });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();

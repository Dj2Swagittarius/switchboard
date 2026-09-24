// Animated wallpaper behind the glass panels. Loaded by nav.js.
//
// Two shaders ported from the WebKit animated-backgrounds kit:
//   dark  -> Silk Flow (soft folds drifting sideways, blue/violet/teal)
//   light -> Opal Film (pastel thin-film iridescence, leans with the pointer)
//
// Everything sits behind frosted glass, so it renders at half resolution and
// 30fps, stops when the window is hidden, and draws one still frame when the
// OS asks for reduced motion. If WebGL is unavailable the static webp from
// glass.css stays in place.
//
// Settings > General > Animated background. Off freezes the shader at the
// moment it was switched off; that moment is kept in localStorage so every
// page shows the same still frame, and the storage event carries a change to
// pages that are already open.
(() => {
  const HEAD = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform vec2 uRes;
uniform float uTime;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p),u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),u.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),u.x),u.y);}
float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<4;i++){v+=a*noise(p);p*=2.03;a*=0.5;}return v;}
`;

  const SILK = HEAD + `
uniform vec3 uC0; uniform vec3 uC1; uniform vec3 uC2; uniform vec3 uBg;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes; uv.y=1.0-uv.y;
  float s=uTime*0.6;
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
  float gr=hash(gl_FragCoord.xy+floor(uTime*5.0)*vec2(13.7,7.3));
  col*=0.92+0.16*gr; col+=(gr-0.5)*0.03;
  gl_FragColor=vec4(uBg+col,1.0);
}`;

  const OPAL = HEAD + `
uniform vec2 uMouse; uniform vec3 uC0; uniform vec3 uBg;
void main(){
  vec2 uv=gl_FragCoord.xy/uRes-0.5; uv.x*=uRes.x/uRes.y;
  float s=uTime*0.7;
  vec2 p=uv+(uMouse-0.5)*0.18;
  vec2 q=vec2(fbm(p*1.1+vec2(0.0,s*0.05)),fbm(p*1.1+vec2(5.2,-s*0.04)));
  float v=fbm(p*1.3+1.6*q+vec2(s*0.06,-s*0.03));
  float t=fract(v*1.6+p.x*0.05);
  vec3 A=vec3(0.45,0.62,0.95),B=vec3(0.45,0.85,0.85),C=vec3(0.62,0.5,0.95),D=vec3(0.95,0.62,0.85);
  float tt=t*4.0;
  vec3 fr=tt<1.0?mix(A,B,tt):tt<2.0?mix(B,C,tt-1.0):tt<3.0?mix(C,D,tt-2.0):mix(D,A,tt-3.0);
  vec3 col=mix(fr,vec3(1.0),0.3)*uC0*2.0;
  col=1.0-exp(-col*1.6);
  float gr=hash(gl_FragCoord.xy+floor(uTime*5.0)*vec2(13.7,7.3));
  col*=0.95+0.1*gr; col+=(gr-0.5)*0.015;
  gl_FragColor=vec4(uBg+col,1.0);
}`;

  const THEMES = {
    dark:  { frag: SILK, u: { uC0: '#2f4fd0', uC1: '#6d4ee6', uC2: '#178fa3', uBg: '#0b0e14' } },
    light: { frag: OPAL, u: { uC0: '#8a9fd6', uBg: '#000000' }, mouse: true },
  };

  const SCALE = 0.5, FPS = 30;
  const rgb = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
  const themeNow = () => document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');

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
    const progs = {};
    for (const [name, t] of Object.entries(THEMES)) {
      const fs = compile(gl.FRAGMENT_SHADER, t.frag);
      if (!vs || !fs) continue;
      const p = gl.createProgram();
      gl.attachShader(p, vs); gl.attachShader(p, fs); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) continue;
      progs[name] = { p, t, uRes: gl.getUniformLocation(p, 'uRes'), uTime: gl.getUniformLocation(p, 'uTime'),
                      uMouse: gl.getUniformLocation(p, 'uMouse') };
    }

    let cur = null;
    const use = () => {
      cur = progs[themeNow()] || null;
      canvas.style.opacity = cur ? '1' : '0';
      if (!cur) return;
      gl.useProgram(cur.p);
      const a = gl.getAttribLocation(cur.p, 'aPos');
      gl.enableVertexAttribArray(a);
      gl.vertexAttribPointer(a, 2, gl.FLOAT, false, 0, 0);
      for (const [k, v] of Object.entries(cur.t.u)) gl.uniform3f(gl.getUniformLocation(cur.p, k), ...rgb(v));
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
      if (cur.uMouse) { mx += (tx - mx) * 0.08; my += (ty - my) * 0.08; gl.uniform2f(cur.uMouse, mx, my); }
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
    // Frozen still follows the pointer on Opal Film; only time stops.
    const moving = () => frozenAt == null || !!cur?.uMouse;
    const start = () => { if (!raf && !document.hidden && !still.matches && moving()) raf = requestAnimationFrame(frame); };
    const stop = () => { cancelAnimationFrame(raf); raf = 0; };
    const applyFrozen = (v) => { frozenAt = v; stop(); draw(); start(); };

    window.switchboardBg = {
      set(on) {
        const v = on ? null : now();
        try { on ? localStorage.removeItem(KEY) : localStorage.setItem(KEY, String(v)); } catch {}
        applyFrozen(v);
      },
    };
    addEventListener('storage', (e) => { if (e.key === KEY || e.key === null) applyFrozen(readFrozen()); });
    // The saved setting wins over this browser's copy (e.g. after Reset).
    fetch('/api/settings').then(r => (r.ok ? r.json() : null)).then(j => {
      const on = j?.settings?.general?.animatedBackground;
      if (typeof on === 'boolean' && on !== (frozenAt == null)) window.switchboardBg.set(on);
    }).catch(() => {});

    use(); resize(); start();
    addEventListener('resize', resize);
    document.addEventListener('visibilitychange', () => (document.hidden ? stop() : start()));
    still.addEventListener?.('change', () => { stop(); draw(); start(); });
    const retheme = () => { use(); stop(); draw(); start(); };
    new MutationObserver(retheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    matchMedia('(prefers-color-scheme:dark)').addEventListener?.('change', retheme);
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); stop(); canvas.style.opacity = '0'; });
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();

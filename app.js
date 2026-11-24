'use strict';
const $ = id => document.getElementById(id);
const cv = $('cv'), ctx = cv.getContext('2d', { willReadFrequently: true });
const work = document.createElement('canvas'), wctx = work.getContext('2d', { willReadFrequently: true });
const ovc = document.createElement('canvas'), octx = ovc.getContext('2d');
const vid = document.createElement('video');
vid.muted = true; vid.playsInline = true;

let stream = null, facingMode = 'environment', timer = null, busy = false;
let currentSource = null, staticImg = null, customDepthImg = null;
let focalFactor = 0.58, lastDetections = [], lastExportRows = [], viewMask = false;
let depthCache = null;

const CLS = [
    { name: 'Verde', rgb: [100, 233, 145] },
    { name: 'Pintón', rgb: [255, 192, 107] },
    { name: 'Maduro', rgb: [255, 90, 90] }
];
const status = m => { $('st').textContent = m; };

// ---------- Color: sRGB -> CIELAB (D65) ----------
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
const fLab = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
function toLab(r, g, b, out) {
    const R = LIN[r], G = LIN[g], B = LIN[b];
    const fx = fLab((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
    const fy = fLab(0.2126 * R + 0.7152 * G + 0.0722 * B);
    const fz = fLab((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
    out[0] = 116 * fy - 16; out[1] = 500 * (fx - fy); out[2] = 200 * (fy - fz);
}
const hueOf = (a, b) => { const h = Math.atan2(b, a) * 57.29578; return h < 0 ? h + 360 : h; };

// Balance de blancos (gray-world recortado)
function whiteBalance(d, n) {
    let sr = 0, sg = 0, sb = 0, k = 0, clip = 0;
    for (let i = 0; i < n; i++) {
        const p = i * 4, r = d[p], g = d[p + 1], b = d[p + 2], mx = Math.max(r, g, b);
        if (mx >= 250) clip++;
        if (mx < 30 || mx >= 250) continue;
        sr += r; sg += g; sb += b; k++;
    }
    if (!k) return { g: [1, 1, 1], clip: clip / n };
    const m = (sr + sg + sb) / 3, cl = v => Math.max(0.8, Math.min(1.25, m / v));
    return { g: [cl(sr), cl(sg), cl(sb)], clip: clip / n };
}

// ---------- Morfología ----------
function erode(m, W, H) {
    const o = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (m[i] && m[i - 1] && m[i + 1] && m[i - W] && m[i + W]) o[i] = 1;
    }
    return o;
}
function dilate(m, W, H) {
    const o = new Uint8Array(W * H);
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
        const i = y * W + x;
        if (m[i] || m[i - 1] || m[i + 1] || m[i - W] || m[i + W]) o[i] = 1;
    }
    return o;
}
function fillHoles(m, W, H) {
    const bg = new Uint8Array(W * H), st = [];
    const push = i => { if (!m[i] && !bg[i]) { bg[i] = 1; st.push(i); } };
    for (let x = 0; x < W; x++) { push(x); push((H - 1) * W + x); }
    for (let y = 0; y < H; y++) { push(y * W); push(y * W + W - 1); }
    while (st.length) {
        const p = st.pop(), x = p % W;
        if (x > 0) push(p - 1);
        if (x < W - 1) push(p + 1);
        if (p >= W) push(p - W);
        if (p < W * (H - 1)) push(p + W);
    }
    const o = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) o[i] = bg[i] ? 0 : 1;
    return o;
}

// Radio inscrito (transformada de distancia)
function inscribed(pix, W, bx, by, bw, bh, fm) {
    const w = bw + 2, h = bh + 2, dt = new Float32Array(w * h);
    for (const p of pix) dt[(((p / W) | 0) - by + 1) * w + (p % W) - bx + 1] = 1e4;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x; if (!dt[i]) continue;
        dt[i] = Math.min(dt[i], dt[i - 1] + 1, dt[i - w] + 1, dt[i - w - 1] + 1.414, dt[i - w + 1] + 1.414);
    }
    let best = 0, bi = 0;
    for (let y = h - 2; y >= 1; y--) for (let x = w - 2; x >= 1; x--) {
        const i = y * w + x; if (!dt[i]) continue;
        dt[i] = Math.min(dt[i], dt[i + 1] + 1, dt[i + w] + 1, dt[i + w + 1] + 1.414, dt[i + w - 1] + 1.414);
        if (dt[i] > best) { best = dt[i]; bi = i; }
    }
    return { r: best, cx: (bi % w) + bx - 1, cy: ((bi / w) | 0) + by - 1 };
}

const hex = (r, g, b) => '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');

// ---------- Procesamiento ----------
function processFrame() {
    if (busy || !currentSource) return;
    let src, sw, sh;
    if (currentSource === 'cam') {
        if (!stream || vid.readyState < 2) return;
        src = vid; sw = vid.videoWidth; sh = vid.videoHeight;
    } else if (staticImg) {
        src = staticImg; sw = staticImg.naturalWidth || staticImg.width; sh = staticImg.naturalHeight || staticImg.height;
    }
    if (!src || !sw || !sh) return;
    busy = true;
    try {
        const W = currentSource === 'cam' ? 400 : 640, H = Math.max(120, Math.round(W * sh / sw)), N = W * H;
        work.width = W; work.height = H;
        wctx.drawImage(src, 0, 0, W, H);
        const raw = wctx.getImageData(0, 0, W, H).data;
        
        // Forzar verde activo por defecto
        const greenEl = $('green');
        const includeGreen = greenEl ? (greenEl.checked || true) : true;

        const wb = $('wb').value === 'auto' ? whiteBalance(raw, N) : { g: [1, 1, 1], clip: 0 };
        if ($('wb').value !== 'auto') { let c = 0; for (let i = 0; i < N; i++) { const p = i * 4; if (Math.max(raw[p], raw[p + 1], raw[p + 2]) >= 250) c++; } wb.clip = c / N; }

        // 1) Máscara en CIELAB
        const lab = [0, 0, 0], L = new Float32Array(N), A = new Float32Array(N), B = new Float32Array(N);
        let mask = new Uint8Array(N), gmask = new Uint8Array(N);
        for (let i = 0; i < N; i++) {
            const p = i * 4;
            toLab(Math.min(255, Math.round(raw[p] * wb.g[0])), Math.min(255, Math.round(raw[p + 1] * wb.g[1])), Math.min(255, Math.round(raw[p + 2] * wb.g[2])), lab);
            L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2];
            const C = Math.hypot(lab[1], lab[2]), h = hueOf(lab[1], lab[2]);
            if (lab[0] < 14 || lab[0] > 92) continue;
            
            // Rojos / Naranjas (Maduro / Pintón)
            if (C >= 30 && (h <= 48 || h >= 345)) {
                mask[i] = 1;
            } 
            // Verdes (Incluye verde puro y verde-limón/amarillento)
            else if (includeGreen && C >= 18 && h >= 75 && h <= 150 && lab[0] > 25 && lab[0] < 90) {
                gmask[i] = 1;
            }
        }
        const clean = m => fillHoles(dilate(erode(dilate(erode(m, W, H), W, H), W, H), W, H), W, H);
        const fmR = clean(mask), fmG = includeGreen ? clean(gmask) : null;

        // 2) Componentes -> medición
        const minArea = 0.003 * N, dets = [];
        const segment = (fm, isGreen) => {
            const vis = new Uint8Array(N);
            for (let s = 0; s < N; s++) {
                if (!fm[s] || vis[s]) continue;
                const st = [s], pix = []; vis[s] = 1;
                let minx = W, maxx = 0, miny = H, maxy = 0;
                while (st.length) {
                    const p = st.pop(), x = p % W, y = (p / W) | 0; pix.push(p);
                    if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
                    if (x > 0 && fm[p - 1] && !vis[p - 1]) { vis[p - 1] = 1; st.push(p - 1); }
                    if (x < W - 1 && fm[p + 1] && !vis[p + 1]) { vis[p + 1] = 1; st.push(p + 1); }
                    if (y > 0 && fm[p - W] && !vis[p - W]) { vis[p - W] = 1; st.push(p - W); }
                    if (y < H - 1 && fm[p + W] && !vis[p + W]) { vis[p + W] = 1; st.push(p + W); }
                }
                const area = pix.length; if (area < minArea) continue;
                const bw = maxx - minx + 1, bh = maxy - miny + 1, asp = bw / bh;
                const solidity = area / (bw * bh);
                
                if (isGreen) {
                    if (solidity < 0.40 || asp < 0.50 || asp > 2.00) continue;
                } else {
                    if (solidity < 0.5) continue;
                }

                const ins = inscribed(pix, W, minx, miny, bw, bh, fm);
                const dA = 2 * Math.sqrt(area / Math.PI), ratio = area / (Math.PI * ins.r * ins.r);
                const touching = ratio > 1.3 || asp > 1.5 || asp < 0.67;
                if (ratio > 2.6) continue;
                const dPx = touching ? 2 * ins.r + 1 : dA;
                let sa = 0, sb = 0, sl = 0, k = 0, rr = 0, gg = 0, bb = 0, cx = 0, cy = 0;
                for (const p of pix) {
                    cx += p % W; cy += (p / W) | 0;
                    if (L[p] >= 20 && L[p] <= 90) {
                        sa += A[p]; sb += B[p]; sl += L[p]; k++;
                        rr += raw[p * 4]; gg += raw[p * 4 + 1]; bb += raw[p * 4 + 2];
                    }
                }
                if (k < area * 0.20) continue;
                
                const hue = hueOf(sa / k, sb / k);
                let c = 2; // Maduro por defecto
                if (isGreen) {
                    c = 0; // Verde
                } else if (hue > 36 && hue < 345) {
                    c = 1; // Pintón
                }

                dets.push({
                    c, pix, area, dPx, touching, solid: Math.min(1, 1 / ratio), hue, C: Math.hypot(sa / k, sb / k),
                    Lm: sl / k, am: sa / k, bm: sb / k, rgb: [rr / k, gg / k, bb / k],
                    cx: touching ? ins.cx : cx / area, cy: touching ? ins.cy : cy / area, fm, W, H
                });
            }
        };
        segment(fmR, false);
        if (fmG) segment(fmG, true);

        // 3) Profundidad externa
        const mode = $('mode').value;
        let ext = null;
        if (mode === 'depth' && customDepthImg) {
            if (!depthCache || depthCache.W !== W || depthCache.H !== H || depthCache.img !== customDepthImg) {
                const c = document.createElement('canvas'); c.width = W; c.height = H;
                const x = c.getContext('2d'); x.drawImage(customDepthImg, 0, 0, W, H);
                depthCache = { W, H, img: customDepthImg, d: x.getImageData(0, 0, W, H).data };
            }
            ext = depthCache.d;
        }
        dets.sort((a, b) => b.area - a.area);
        lastDetections = dets;

        // 4) Dibujo
        cv.width = sw; cv.height = sh;
        ctx.drawImage(src, 0, 0, sw, sh);
        const sx = sw / W, sy = sh / H;
        const dMin = parseFloat($('dmin').value) || 15, dMax = parseFloat($('dmax').value) || 60;
        const typD = parseFloat($('D').value) || 65, refZ = (parseFloat($('cal').value) || 30) * 10;
        const fx = focalFactor * W;
        const ov = octx.createImageData(W, H); ovc.width = W; ovc.height = H;
        let nOk = 0, nMad = 0, nPin = 0, nOut = 0; const rows = [];
        const fs = Math.max(13, Math.round(sw / 48)); ctx.font = `bold ${fs}px system-ui, sans-serif`;

        dets.slice(0, 15).forEach((d, idx) => {
            let dist, diamMM;
            if (ext) {
                let zs = 0; for (const p of d.pix) zs += ext[p * 4];
                const near = parseFloat($('mNear').value) || 10, far = parseFloat($('mFar').value) || 100;
                dist = far - (zs / d.pix.length / 255) * (far - near);
                diamMM = d.dPx * dist * 10 / fx;
            } else {
                dist = (typD * fx / d.dPx) / 10;
                diamMM = d.dPx * refZ / fx;
            }
            const inRange = mode === 'off' || (dist >= dMin && dist <= dMax);
            if (inRange) { nOk++; if (d.c === 2) nMad++; if (d.c === 1) nPin++; } else nOut++;
            const col = inRange ? CLS[d.c].rgb : [122, 130, 125], real = hex(...d.rgb);
            for (const p of d.pix) {
                const edge = !(d.fm[p - 1] && d.fm[p + 1] && d.fm[p - W] && d.fm[p + W]);
                const o = p * 4;
                if (edge) { ov.data[o] = col[0]; ov.data[o + 1] = col[1]; ov.data[o + 2] = col[2]; ov.data[o + 3] = 255; }
                else if (viewMask) { ov.data[o] = col[0]; ov.data[o + 1] = col[1]; ov.data[o + 2] = col[2]; ov.data[o + 3] = 120; }
            }
            rows.push({ id: idx + 1, madurez: CLS[d.c].name, diametro: (diamMM / 10).toFixed(2), distancia: dist.toFixed(1),
                color: real, L: d.Lm.toFixed(1), a: d.am.toFixed(1), b: d.bm.toFixed(1), matiz: d.hue.toFixed(0),
                ocluido: d.touching ? 'si' : 'no', estado: inRange ? 'Aceptado' : 'Fuera_de_rango' });
            d._lbl = { x: d.cx * sx, y: d.cy * sy, r: d.dPx / 2 * (sx + sy) / 2, inRange, col, real, dist, diam: (diamMM / 10).toFixed(1), tw: d.touching };
        });
        octx.putImageData(ov, 0, 0);
        ctx.imageSmoothingEnabled = false; ctx.drawImage(ovc, 0, 0, sw, sh); ctx.imageSmoothingEnabled = true;

        dets.slice(0, 15).forEach(d => {
            const l = d._lbl, css = `rgb(${l.col.join(',')})`;
            const t = l.inRange ? `${CLS[d.c].name} · Ø ${l.diam} cm${l.tw ? '*' : ''} · ${l.dist.toFixed(0)} cm` : `Fuera de rango (${l.dist.toFixed(0)} cm)`;
            const tw = ctx.measureText(t).width + fs + 18, lh = fs + 8;
            const lx = Math.max(4, Math.min(sw - tw - 4, l.x - tw / 2)), ly = Math.max(4, l.y - l.r - lh - 5);
            ctx.fillStyle = 'rgba(10,18,14,.88)'; ctx.fillRect(lx, ly, tw, lh);
            ctx.fillStyle = l.real; ctx.fillRect(lx + 4, ly + 4, fs, fs);
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.strokeRect(lx + 4, ly + 4, fs, fs);
            ctx.fillStyle = css; ctx.fillText(t, lx + fs + 10, ly + fs);
        });

        lastExportRows = rows;
        $('nOk').textContent = nOk; $('nMad').textContent = nMad; $('nPin').textContent = nPin; $('nOut').textContent = nOut;
        if (wb.clip > 0.12) status(`⚠ ${(wb.clip * 100).toFixed(0)}% de la imagen está sobreexpuesta: baja la exposición o haz sombra.`);
        else if (currentSource === 'cam') status(`Cámara activa · WB ${$('wb').value === 'auto' ? 'auto' : 'off'} · ${dets.length} fruto(s)`);
    } catch (e) { console.error(e); status('Error al procesar el fotograma.'); }
    finally { busy = false; }
}

// ---------- Cámara ----------
async function startCamera() {
    if (!navigator.mediaDevices?.getUserMedia) { status('Tu navegador no soporta la cámara o requiere HTTPS.'); return; }
    try {
        status('Solicitando acceso a la cámara...');
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } } });
        try {
            const tr = stream.getVideoTracks()[0], cap = tr.getCapabilities ? tr.getCapabilities() : {};
            const adv = {};
            if (cap.exposureCompensation) adv.exposureCompensation = Math.max(cap.exposureCompensation.min, Math.min(cap.exposureCompensation.max, -1));
            if (cap.whiteBalanceMode && cap.whiteBalanceMode.includes('continuous')) adv.whiteBalanceMode = 'continuous';
            if (Object.keys(adv).length) await tr.applyConstraints({ advanced: [adv] });
        } catch (_) {}
        vid.srcObject = stream; await vid.play();
        currentSource = 'cam'; $('hint').hidden = true;
        $('bCam').textContent = 'Detener cámara'; $('bFlip').disabled = false;
        timer = setInterval(processFrame, 140);
    } catch (e) { console.error(e); status(`No se pudo abrir la cámara (${e.name}: ${e.message}).`); stopCamera(); }
}
function stopCamera() {
    if (timer) { clearInterval(timer); timer = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    vid.srcObject = null; $('bCam').textContent = 'Abrir cámara'; $('bFlip').disabled = true;
    if (!staticImg && currentSource === 'cam') { $('hint').hidden = false; currentSource = null; }
}
const redo = () => { if (currentSource && currentSource !== 'cam') processFrame(); };

document.addEventListener('DOMContentLoaded', () => {
    $('bCam').addEventListener('click', () => stream ? (stopCamera(), status('Cámara detenida.')) : startCamera());
    $('bFlip').addEventListener('click', async () => { if (!stream) return; facingMode = facingMode === 'environment' ? 'user' : 'environment'; stopCamera(); await startCamera(); });
    $('dmin').addEventListener('input', e => { $('vMin').textContent = `${e.target.value} cm`; redo(); });
    $('dmax').addEventListener('input', e => { $('vMax').textContent = `${e.target.value} cm`; redo(); });
    $('mode').addEventListener('change', e => { $('depthBox').hidden = e.target.value !== 'depth'; $('estNote').hidden = e.target.value !== 'est'; redo(); });
    $('green').addEventListener('change', redo);
    $('wb').addEventListener('change', redo);
    $('bView').textContent = 'Vista: Real (contorno)';
    $('bView').addEventListener('click', () => { viewMask = !viewMask; $('bView').textContent = viewMask ? 'Vista: Máscara' : 'Vista: Real (contorno)'; redo(); });

    $('bCsv').addEventListener('click', () => {
        if (!lastExportRows.length) { status('No hay detecciones para exportar.'); return; }
        const h = ['ID', 'Madurez', 'Diametro_cm', 'Distancia_cm', 'Color_real_hex', 'L*', 'a*', 'b*', 'Matiz_deg', 'Ocluido', 'Estado'];
        const lines = [h.join(','), ...lastExportRows.map(r => [r.id, r.madurez, r.diametro, r.distancia, r.color, r.L, r.a, r.b, r.matiz, r.ocluido, r.estado].join(','))];
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' }));
        a.download = `jitomates_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`; a.click();
        status('CSV descargado.');
    });

    const loadImg = (file, cb) => { const img = new Image(); img.onload = () => cb(img); img.src = URL.createObjectURL(file); };
    $('bPhoto').addEventListener('click', () => $('fPhoto').click());
    $('fPhoto').addEventListener('change', e => {
        const f = e.target.files?.[0]; if (!f) return; stopCamera();
        loadImg(f, img => { staticImg = img; currentSource = 'img'; $('hint').hidden = true; status('Foto cargada · analizando'); processFrame(); });
    });
    $('bDepth').addEventListener('click', () => $('fDepth').click());
    $('fDepth').addEventListener('change', e => {
        const f = e.target.files?.[0]; if (!f) return;
        loadImg(f, img => { customDepthImg = img; status('Mapa de profundidad cargado.'); if (currentSource) processFrame(); });
    });

    $('bDemo').addEventListener('click', () => {
        stopCamera();
        const c = document.createElement('canvas'); c.width = 640; c.height = 480;
        const d = c.getContext('2d'); d.fillStyle = '#3a4a2a'; d.fillRect(0, 0, 640, 480);
        for (const s of [{ x: 180, y: 240, r: 62, a: '#ff3b30', b: '#9e1911' }, { x: 370, y: 210, r: 46, a: '#ff9500', b: '#b35900' }, { x: 510, y: 270, r: 34, a: '#e0281e', b: '#7a100a' }]) {
            const g = d.createRadialGradient(s.x - s.r * .3, s.y - s.r * .3, s.r * .1, s.x, s.y, s.r);
            g.addColorStop(0, s.a); g.addColorStop(1, s.b); d.fillStyle = g;
            d.beginPath(); d.arc(s.x, s.y, s.r, 0, 7); d.fill();
            d.fillStyle = 'rgba(255,255,255,.9)'; d.beginPath(); d.ellipse(s.x - s.r * .35, s.y - s.r * .4, s.r * .15, s.r * .09, -.6, 0, 7); d.fill();
        }
        const img = new Image();
        img.onload = () => { staticImg = img; currentSource = 'demo'; $('hint').hidden = true; status('Escena de ejemplo cargada'); processFrame(); };
        img.src = c.toDataURL();
    });

    $('bCal').addEventListener('click', () => {
        if (!lastDetections.length) { status('Detecta al menos un jitomate para calibrar.'); return; }
        const d = lastDetections[0], D = parseFloat($('D').value) || 65, Z = (parseFloat($('cal').value) || 30) * 10;
        focalFactor = Math.max(0.2, Math.min(2.5, (d.dPx * Z / D) / d.W));
        $('fnote').textContent = `Foco calibrado: ${focalFactor.toFixed(2)} × ancho de imagen.`;
        status(`Calibrado con fruto de ${D} mm a ${Z / 10} cm.`); redo();
    });
});

'use strict';
const $ = id => document.getElementById(id);

const cv = $('cv');
const ctx = cv.getContext('2d', { willReadFrequently: true });
const work = document.createElement('canvas');
const wctx = work.getContext('2d', { willReadFrequently: true });
const vid = document.createElement('video');
vid.muted = true;
vid.playsInline = true;

let stream = null;
let timer = null;
let busy = false;
let currentSource = null; // 'cam', 'img', 'demo'
let staticImg = null;
let customDepthImg = null;
let focalFactor = 0.78;
let lastDetections = [];

const COLORS = [
    { key: 'green', name: 'Verde', rgb: '#64e991' },
    { key: 'turning', name: 'Pintón', rgb: '#ffc06b' },
    { key: 'red', name: 'Maduro', rgb: '#ff7777' }
];

function status(msg) {
    const el = $('st');
    if (el) el.textContent = msg;
}

// --- CONTROLES DE INTERFAZ ---
$('dmin').addEventListener('input', e => {
    $('vMin').textContent = `${e.target.value} cm`;
    if (currentSource && currentSource !== 'cam') processFrame();
});

$('dmax').addEventListener('input', e => {
    $('vMax').textContent = `${e.target.value} cm`;
    if (currentSource && currentSource !== 'cam') processFrame();
});

$('mode').addEventListener('change', e => {
    const val = e.target.value;
    $('depthBox').hidden = (val !== 'depth');
    $('estNote').hidden = (val !== 'est');
    if (currentSource && currentSource !== 'cam') processFrame();
});

$('green').addEventListener('change', () => {
    if (currentSource && currentSource !== 'cam') processFrame();
});

// --- CÁMARA ---
async function toggleCamera() {
    if (stream) {
        stopCamera();
        status('Cámara detenida.');
        return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        status('Tu navegador no soporta acceso a la cámara o requiere HTTPS.');
        return;
    }
    try {
        status('Solicitando acceso a la cámara...');
        stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        vid.srcObject = stream;
        await vid.play();
        currentSource = 'cam';
        $('hint').hidden = true;
        $('bCam').textContent = 'Detener cámara';
        status('Cámara activa · Metrología HSV y profundidad');
        timer = setInterval(processFrame, 110);
    } catch (err) {
        console.error('Error detallado de cámara:', err);
        status(`No se pudo abrir la cámara (${err.name}: ${err.message}).`);
        stopCamera();
    }
}

function stopCamera() {
    if (timer) { clearInterval(timer); timer = null; }
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    vid.srcObject = null;
    $('bCam').textContent = 'Abrir cámara';
    if (!staticImg && currentSource === 'cam') {
        $('hint').hidden = false;
        currentSource = null;
    }
}

$('bCam').addEventListener('click', toggleCamera);

// --- SUBIR FOTO Y MAPA DE PROFUNDIDAD ---
$('bPhoto').addEventListener('click', () => $('fPhoto').click());
$('fPhoto').addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    stopCamera();
    const img = new Image();
    img.onload = () => {
        staticImg = img;
        currentSource = 'img';
        $('hint').hidden = true;
        status('Foto cargada · Analizando');
        processFrame();
    };
    img.src = URL.createObjectURL(file);
});

$('bDepth').addEventListener('click', () => $('fDepth').click());
$('fDepth').addEventListener('change', e => {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = new Image();
    img.onload = () => {
        customDepthImg = img;
        status('Mapa de profundidad externo cargado.');
        if (currentSource) processFrame();
    };
    img.src = URL.createObjectURL(file);
});

// --- ESCENA DE EJEMPLO ---
$('bDemo').addEventListener('click', () => {
    stopCamera();
    const demoCv = document.createElement('canvas');
    demoCv.width = 640;
    demoCv.height = 480;
    const dctx = demoCv.getContext('2d');

    dctx.fillStyle = '#1e2420';
    dctx.fillRect(0, 0, 640, 480);

    const samples = [
        { x: 180, y: 240, r: 62, c1: '#ff3b30', c2: '#9e1911' },
        { x: 370, y: 210, r: 46, c1: '#ff9500', c2: '#b35900' },
        { x: 510, y: 270, r: 24, c1: '#e0281e', c2: '#7a100a' }
    ];

    for (const s of samples) {
        const grad = dctx.createRadialGradient(s.x - s.r * 0.3, s.y - s.r * 0.3, s.r * 0.1, s.x, s.y, s.r);
        grad.addColorStop(0, s.c1);
        grad.addColorStop(1, s.c2);
        dctx.fillStyle = grad;
        dctx.beginPath();
        dctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        dctx.fill();
    }

    const img = new Image();
    img.onload = () => {
        staticImg = img;
        currentSource = 'demo';
        $('hint').hidden = true;
        status('Escena de ejemplo cargada');
        processFrame();
    };
    img.src = demoCv.toDataURL();
});

// --- CALIBRACIÓN FOCAL ---
$('bCal').addEventListener('click', () => {
    if (!lastDetections.length) {
        status('Detecta al menos un jitomate para calibrar.');
        return;
    }
    const largest = lastDetections[0];
    const realD_mm = parseFloat($('D').value) || 65;
    const realZ_mm = (parseFloat($('cal').value) || 30) * 10;
    const newFocalPx = (largest.eqDiameterPx * realZ_mm) / realD_mm;
    focalFactor = Math.max(0.2, Math.min(2.5, newFocalPx / largest.W));
    $('fnote').textContent = `Foco calibrado: ${focalFactor.toFixed(2)} × ancho de imagen.`;
    status(`Calibrado con fruto de ${realD_mm} mm a ${realZ_mm / 10} cm.`);
    if (currentSource !== 'cam') processFrame();
});

// --- CONVERSIÓN HSV Y CLASIFICACIÓN ROBUSTA ---
function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        else if (max === g) h = ((b - r) / d + 2) * 60;
        else h = ((r - g) / d + 4) * 60;
    }
    const s = max === 0 ? 0 : d / max;
    return [h, s, max];
}

function classify(r, g, b, includeGreen) {
    const [h, s, v] = rgbToHsv(r, g, b);
    if (s < 0.38 || v < 0.18) return -1;
    if ((h <= 14 || h >= 342) && s > 0.45) return 2; // Maduro
    if (h > 14 && h <= 38 && s > 0.45) return 1;      // Pintón
    if (includeGreen && h >= 65 && h <= 150 && s > 0.35) return 0; // Verde
    return -1;
}

function depthColormap(val) {
    const r = Math.min(255, Math.max(0, Math.round(1.5 * val - 128)));
    const g = Math.min(255, Math.max(0, Math.round(255 - Math.abs(val - 128) * 2)));
    const b = Math.min(255, Math.max(0, Math.round(255 - 1.5 * val)));
    return [r, g, b];
}

// --- MOTOR DE VISIÓN Y METROLOGÍA ---
function processFrame() {
    if (busy || !currentSource) return;
    let srcEl = null, srcW = 0, srcH = 0;

    if (currentSource === 'cam') {
        if (!stream || vid.readyState < 2) return;
        srcEl = vid;
        srcW = vid.videoWidth;
        srcH = vid.videoHeight;
    } else if (staticImg) {
        srcEl = staticImg;
        srcW = staticImg.naturalWidth || staticImg.width;
        srcH = staticImg.naturalHeight || staticImg.height;
    }
    if (!srcEl || !srcW || !srcH) return;

    busy = true;
    try {
        const W = 320; // Resolución aumentada para bordes precisos
        const H = Math.max(180, Math.round(W * (srcH / srcW)));
        work.width = W;
        work.height = H;
        wctx.drawImage(srcEl, 0, 0, W, H);

        const rawData = wctx.getImageData(0, 0, W, H).data;
        const depthFrame = wctx.createImageData(W, H);
        const depthData = depthFrame.data;
        const depthMap = new Float32Array(W * H);

        let extDepthData = null;
        if ($('mode').value === 'depth' && customDepthImg) {
            const dCv = document.createElement('canvas');
            dCv.width = W; dCv.height = H;
            const dCtx = dCv.getContext('2d');
            dCtx.drawImage(customDepthImg, 0, 0, W, H);
            extDepthData = dCtx.getImageData(0, 0, W, H).data;
        }

        for (let i = 0; i < W * H; i++) {
            const p = i * 4;
            let zScore;
            if (extDepthData) {
                zScore = extDepthData[p];
            } else {
                const r = rawData[p], g = rawData[p + 1], b = rawData[p + 2];
                const lum = 0.299 * r + 0.587 * g + 0.114 * b;
                const sat = Math.max(r, g, b) - Math.min(r, g, b);
                zScore = Math.min(255, lum * 0.75 + sat * 0.35);
            }
            depthMap[i] = zScore;
            const [dr, dg, db] = depthColormap(zScore);
            depthData[p] = dr; depthData[p + 1] = dg; depthData[p + 2] = db; depthData[p + 3] = 255;
        }

        const includeGreen = $('green').checked;
        const masks = COLORS.map(() => new Uint8Array(W * H));
        for (let i = 0; i < W * H; i++) {
            const p = i * 4;
            const c = classify(rawData[p], rawData[p + 1], rawData[p + 2], includeGreen);
            if (c >= 0) masks[c][i] = 1;
        }

        const detections = [];
        for (let c = 0; c < 3; c++) {
            if (c === 0 && !includeGreen) continue;
            const mask = masks[c], visited = new Uint8Array(W * H);
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    const seed = y * W + x;
                    if (!mask[seed] || visited[seed]) continue;

                    let stack = [seed], pixelCount = 0;
                    let sumX = 0, sumY = 0, zSum = 0;
                    let minx = W, maxx = 0, miny = H, maxy = 0;
                    visited[seed] = 1;

                    while (stack.length) {
                        const p = stack.pop(), px = p % W, py = (p / W) | 0;
                        pixelCount++;
                        sumX += px; sumY += py;
                        zSum += depthMap[p];
                        if (px < minx) minx = px; if (px > maxx) maxx = px;
                        if (py < miny) miny = py; if (py > maxy) maxy = py;

                        for (const n of [p - 1, p + 1, p - W, p + W]) {
                            if (n < 0 || n >= W * H || visited[n] || !mask[n]) continue;
                            if (Math.abs(n % W - px) + Math.abs(((n / W) | 0) - py) !== 1) continue;
                            visited[n] = 1; stack.push(n);
                        }
                    }

                    const bw = maxx - minx + 1, bh = maxy - miny + 1;
                    const solidity = pixelCount / (bw * bh);
                    const aspect = bw / bh;

                    if (pixelCount >= 220 && solidity > 0.44 && aspect > 0.55 && aspect < 1.8) {
                        const cx = sumX / pixelCount;
                        const cy = sumY / pixelCount;
                        const eqDiameterPx = 2 * Math.sqrt(pixelCount / Math.PI);
                        const meanZ = zSum / pixelCount;
                        detections.push({ c, cx, cy, eqDiameterPx, pixelCount, meanZ, W, H });
                    }
                }
            }
        }

        detections.sort((a, b) => b.pixelCount - a.pixelCount);
        lastDetections = detections;

        cv.width = srcW;
        cv.height = srcH;
        wctx.putImageData(depthFrame, 0, 0);
        ctx.clearRect(0, 0, cv.width, cv.height);
        ctx.drawImage(work, 0, 0, cv.width, cv.height);

        const mode = $('mode').value;
        const dMinCM = parseFloat($('dmin').value) || 15;
        const dMaxCM = parseFloat($('dmax').value) || 60;
        const typicalD_mm = parseFloat($('D').value) || 65;
        const focalPx_W = focalFactor * W;

        let countOk = 0, countMad = 0, countPin = 0, countOut = 0;
        const sx = cv.width / W, sy = cv.height / H;
        const fontSize = Math.max(13, Math.round(cv.width / 48));
        ctx.font = `bold ${fontSize}px system-ui, sans-serif`;

        for (const d of detections.slice(0, 12)) {
            let distCM = 30;
            let diamMM = typicalD_mm;

            if (mode === 'depth' && extDepthData) {
                const nearCM = parseFloat($('mNear').value) || 10;
                const farCM = parseFloat($('mFar').value) || 100;
                distCM = farCM - (d.meanZ / 255) * (farCM - nearCM);
                diamMM = (d.eqDiameterPx * (distCM * 10)) / focalPx_W;
            } else {
                const rawDistMM = (typicalD_mm * focalPx_W) / d.eqDiameterPx;
                distCM = rawDistMM / 10;
                const calZ_mm = (parseFloat($('cal').value) || 30) * 10;
                diamMM = (d.eqDiameterPx * calZ_mm) / focalPx_W;
            }

            const inRange = (mode === 'off') || (distCM >= dMinCM && distCM <= dMaxCM);

            if (inRange) {
                countOk++;
                if (d.c === 2) countMad++;
                if (d.c === 1) countPin++;
            } else {
                countOut++;
            }

            const realCx = d.cx * sx;
            const realCy = d.cy * sy;
            const realRadius = (d.eqDiameterPx / 2) * ((sx + sy) / 2);
            const strokeColor = inRange ? COLORS[d.c].rgb : '#7a827d';

            ctx.save();
            if (!inRange) ctx.setLineDash([6, 6]);
            ctx.beginPath();
            ctx.arc(realCx, realCy, realRadius, 0, Math.PI * 2);
            ctx.strokeStyle = strokeColor;
            ctx.lineWidth = inRange ? 3 : 2;
            ctx.stroke();
            ctx.restore();

            if (inRange) {
                ctx.beginPath();
                ctx.moveTo(realCx - realRadius, realCy);
                ctx.lineTo(realCx + realRadius, realCy);
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2;
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(realCx, realCy, 3.5, 0, Math.PI * 2);
                ctx.fillStyle = '#ffffff';
                ctx.fill();
            }

            const diamCM = (diamMM / 10).toFixed(1);
            const label = inRange
                ? `${COLORS[d.c].name} · Ø ${diamCM} cm · ${distCM.toFixed(0)} cm`
                : `Fuera de rango (${distCM.toFixed(0)} cm)`;

            const textW = ctx.measureText(label).width + 12;
            const labelH = fontSize + 8;
            const lx = Math.max(4, Math.min(cv.width - textW - 4, realCx - textW / 2));
            const ly = Math.max(4, realCy - realRadius - labelH - 5);

            ctx.fillStyle = 'rgba(10, 18, 14, 0.88)';
            ctx.fillRect(lx, ly, textW, labelH);
            ctx.fillStyle = strokeColor;
            ctx.fillText(label, lx + 6, ly + fontSize);
        }

        $('nOk').textContent = countOk;
        $('nMad').textContent = countMad;
        $('nPin').textContent = countPin;
        $('nOut').textContent = countOut;

    } catch (err) {
        console.error(err);
        status('Error al procesar el fotograma.');
    } finally {
        busy = false;
    }
}
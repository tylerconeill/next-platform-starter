'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

const DEFAULT_IMAGE = '/images/corgi.jpg';
const PRESET_SPOT_COLORS = ['#111111', '#f5f5f5', '#e11d48', '#0ea5e9', '#16a34a', '#f59e0b', '#7c3aed', '#334155'];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const hexToRgb = (hex) => {
    const value = hex.replace('#', '');
    const parsed = Number.parseInt(value, 16);
    return {
        r: (parsed >> 16) & 255,
        g: (parsed >> 8) & 255,
        b: parsed & 255,
    };
};

const rgbDistance = (a, b) => {
    const dr = a.r - b.r;
    const dg = a.g - b.g;
    const db = a.b - b.b;
    return Math.sqrt(dr * dr + dg * dg + db * db);
};

const rgbToHex = ({ r, g, b }) =>
    `#${[r, g, b]
        .map((value) => Math.round(clamp(value, 0, 255)).toString(16).padStart(2, '0'))
        .join('')}`;

const cmykFromRgb = ({ r, g, b }) => {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;

    const k = 1 - Math.max(rn, gn, bn);
    if (k >= 0.999) {
        return { c: 0, m: 0, y: 0, k: 1 };
    }

    const denom = 1 - k;
    return {
        c: (1 - rn - k) / denom,
        m: (1 - gn - k) / denom,
        y: (1 - bn - k) / denom,
        k,
    };
};

const buildSpotCentroids = (pixels, channels) => {
    const sampleStep = Math.max(1, Math.floor(pixels.length / 4 / 12000));
    const samples = [];

    for (let i = 0; i < pixels.length; i += 4 * sampleStep) {
        samples.push({ r: pixels[i], g: pixels[i + 1], b: pixels[i + 2] });
    }

    if (samples.length === 0) {
        return [];
    }

    const centroids = [];
    const stride = Math.max(1, Math.floor(samples.length / channels));

    for (let i = 0; i < channels; i += 1) {
        centroids.push(samples[Math.min(i * stride, samples.length - 1)]);
    }

    for (let pass = 0; pass < 7; pass += 1) {
        const accum = Array.from({ length: channels }, () => ({ r: 0, g: 0, b: 0, count: 0 }));

        for (const sample of samples) {
            let closest = 0;
            let minDistance = Number.POSITIVE_INFINITY;

            for (let i = 0; i < centroids.length; i += 1) {
                const distance = rgbDistance(sample, centroids[i]);
                if (distance < minDistance) {
                    minDistance = distance;
                    closest = i;
                }
            }

            accum[closest].r += sample.r;
            accum[closest].g += sample.g;
            accum[closest].b += sample.b;
            accum[closest].count += 1;
        }

        for (let i = 0; i < centroids.length; i += 1) {
            if (accum[i].count > 0) {
                centroids[i] = {
                    r: accum[i].r / accum[i].count,
                    g: accum[i].g / accum[i].count,
                    b: accum[i].b / accum[i].count,
                };
            }
        }
    }

    return centroids;
};

export function SeparationStudio() {
    const sourceCanvasRef = useRef(null);
    const proofCanvasRef = useRef(null);

    const [imageSrc, setImageSrc] = useState(DEFAULT_IMAGE);
    const [status, setStatus] = useState('Upload artwork to build process and spot channel simulations.');

    const [mode, setMode] = useState('spot');
    const [spotChannels, setSpotChannels] = useState(4);
    const [dotSize, setDotSize] = useState(9);
    const [dotGain, setDotGain] = useState(0.92);
    const [activeLayer, setActiveLayer] = useState(0);

    const [layers, setLayers] = useState([]);
    const [angles, setAngles] = useState([15, 45, 75, 0, 22, 52, 82, 12]);

    const channelCanvasRef = useRef(null);

    const sortedLayers = useMemo(() => layers.map((layer, idx) => ({ ...layer, idx })), [layers]);

    useEffect(() => {
        const sourceCanvas = sourceCanvasRef.current;
        const proofCanvas = proofCanvasRef.current;
        if (!sourceCanvas || !proofCanvas) {
            return;
        }

        const image = new Image();
        image.crossOrigin = 'anonymous';

        image.onload = () => {
            const targetWidth = 620;
            const ratio = image.height / image.width;
            const targetHeight = Math.round(targetWidth * ratio);

            sourceCanvas.width = targetWidth;
            sourceCanvas.height = targetHeight;
            proofCanvas.width = targetWidth;
            proofCanvas.height = targetHeight;

            const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
            const proofCtx = proofCanvas.getContext('2d');
            if (!sourceCtx || !proofCtx) {
                return;
            }

            sourceCtx.clearRect(0, 0, targetWidth, targetHeight);
            sourceCtx.drawImage(image, 0, 0, targetWidth, targetHeight);

            const sourceData = sourceCtx.getImageData(0, 0, targetWidth, targetHeight);
            const raw = sourceData.data;
            const pixelCount = targetWidth * targetHeight;

            let nextLayers = [];

            if (mode === 'process') {
                const processSwatches = [
                    { name: 'Cyan', hex: '#00a8e8', key: 'c' },
                    { name: 'Magenta', hex: '#e3008c', key: 'm' },
                    { name: 'Yellow', hex: '#ffd400', key: 'y' },
                    { name: 'Black', hex: '#111111', key: 'k' },
                ];

                const masks = processSwatches.map(() => new Float32Array(pixelCount));

                for (let i = 0; i < raw.length; i += 4) {
                    const px = i / 4;
                    const cmyk = cmykFromRgb({ r: raw[i], g: raw[i + 1], b: raw[i + 2] });
                    masks[0][px] = cmyk.c;
                    masks[1][px] = cmyk.m;
                    masks[2][px] = cmyk.y;
                    masks[3][px] = cmyk.k;
                }

                nextLayers = processSwatches.map((swatch, idx) => ({
                    name: swatch.name,
                    hex: swatch.hex,
                    strength: masks[idx],
                    width: targetWidth,
                    height: targetHeight,
                    angle: angles[idx] ?? 0,
                    enabled: true,
                }));
            } else {
                const centroids = buildSpotCentroids(raw, spotChannels);
                const masks = centroids.map(() => new Float32Array(pixelCount));

                for (let i = 0; i < raw.length; i += 4) {
                    const pixel = { r: raw[i], g: raw[i + 1], b: raw[i + 2] };
                    let closest = 0;
                    let minDistance = Number.POSITIVE_INFINITY;

                    centroids.forEach((centroid, idx) => {
                        const distance = rgbDistance(pixel, centroid);
                        if (distance < minDistance) {
                            minDistance = distance;
                            closest = idx;
                        }
                    });

                    const px = i / 4;
                    const normalized = 1 - clamp(minDistance / 255, 0, 1);
                    masks[closest][px] = clamp(normalized * 1.15, 0, 1);
                }

                nextLayers = centroids.map((centroid, idx) => ({
                    name: `Spot ${idx + 1}`,
                    hex: PRESET_SPOT_COLORS[idx] ?? rgbToHex(centroid),
                    strength: masks[idx],
                    width: targetWidth,
                    height: targetHeight,
                    angle: angles[idx] ?? 0,
                    enabled: true,
                }));
            }

            setLayers(nextLayers);
            setActiveLayer((current) => clamp(current, 0, Math.max(nextLayers.length - 1, 0)));
            setStatus(`Built ${nextLayers.length} ${mode} channels at ${targetWidth}x${targetHeight}.`);
        };

        image.onerror = () => setStatus('Unable to load image. Please upload a valid raster image.');
        image.src = imageSrc;
    }, [angles, imageSrc, mode, spotChannels]);

    useEffect(() => {
        if (!layers.length) {
            return;
        }

        const proofCanvas = proofCanvasRef.current;
        if (!proofCanvas) {
            return;
        }

        const ctx = proofCanvas.getContext('2d');
        if (!ctx) {
            return;
        }

        const { width, height } = layers[0];
        const output = ctx.createImageData(width, height);

        for (let i = 0; i < output.data.length; i += 4) {
            output.data[i] = 255;
            output.data[i + 1] = 255;
            output.data[i + 2] = 255;
            output.data[i + 3] = 255;
        }

        const enabledLayers = layers.filter((layer) => layer.enabled !== false);

        for (const layer of enabledLayers) {
            const ink = hexToRgb(layer.hex);
            for (let i = 0; i < output.data.length; i += 4) {
                const px = i / 4;
                const alpha = clamp((layer.strength[px] ?? 0) * dotGain, 0, 1);
                if (alpha < 0.01) {
                    continue;
                }

                output.data[i] = clamp(output.data[i] * (1 - alpha) + (output.data[i] * ink.r * alpha) / 255, 0, 255);
                output.data[i + 1] = clamp(output.data[i + 1] * (1 - alpha) + (output.data[i + 1] * ink.g * alpha) / 255, 0, 255);
                output.data[i + 2] = clamp(output.data[i + 2] * (1 - alpha) + (output.data[i + 2] * ink.b * alpha) / 255, 0, 255);
            }
        }

        ctx.putImageData(output, 0, 0);
    }, [dotGain, layers]);

    useEffect(() => {
        const layer = sortedLayers[activeLayer];
        const canvas = channelCanvasRef.current;
        if (!layer || !canvas) {
            return;
        }

        canvas.width = layer.width;
        canvas.height = layer.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return;
        }

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, layer.width, layer.height);
        ctx.fillStyle = '#111111';

        const radians = (layer.angle * Math.PI) / 180;
        const cos = Math.cos(radians);
        const sin = Math.sin(radians);

        for (let y = dotSize / 2; y < layer.height; y += dotSize) {
            for (let x = dotSize / 2; x < layer.width; x += dotSize) {
                const rx = Math.floor(x * cos - y * sin);
                const ry = Math.floor(x * sin + y * cos);
                const sx = clamp(Math.abs(rx) % layer.width, 0, layer.width - 1);
                const sy = clamp(Math.abs(ry) % layer.height, 0, layer.height - 1);
                const idx = sy * layer.width + sx;
                const strength = clamp((layer.strength[idx] ?? 0) * dotGain, 0, 1);
                const radius = (dotSize * strength) / 2;

                if (radius < 0.25) {
                    continue;
                }

                ctx.beginPath();
                ctx.arc(x, y, radius, 0, Math.PI * 2);
                ctx.fill();
            }
        }
    }, [activeLayer, dotGain, dotSize, sortedLayers]);

    const onUpload = (event) => {
        const file = event.target.files?.[0];
        if (!file) {
            return;
        }

        const nextUrl = URL.createObjectURL(file);
        setImageSrc(nextUrl);
        setStatus(`Loaded ${file.name}. Rebuilding ${mode} channels...`);
    };

    const updateLayer = (index, updates) => {
        setLayers((prev) => prev.map((layer, i) => (i === index ? { ...layer, ...updates } : layer)));
    };

    const active = layers[activeLayer];

    return (
        <main className="mx-auto flex w-full max-w-7xl flex-col gap-7 px-4 py-8 sm:px-6 lg:px-8">
            <section className="space-y-2">
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">Simulated Process + Spot Workflow</p>
                <h1>Channel Separation Studio</h1>
                <p className="max-w-4xl text-sm text-neutral-300">
                    Built for simulated production proofs: split artwork into process or spot channels, tune screen angles, and preview
                    overprint behavior before film output.
                </p>
            </section>

            <section className="grid gap-4 rounded-lg border border-neutral-800 bg-neutral-950/80 p-4 md:grid-cols-2 xl:grid-cols-6">
                <label className="flex flex-col gap-2 text-sm xl:col-span-2">
                    <span className="font-semibold">Artwork</span>
                    <input className="input" type="file" accept="image/*" onChange={onUpload} />
                </label>

                <label className="flex flex-col gap-2 text-sm">
                    <span className="font-semibold">Separation mode</span>
                    <select className="input" value={mode} onChange={(e) => setMode(e.target.value)}>
                        <option value="spot">Spot channels (auto)</option>
                        <option value="process">Process CMYK</option>
                    </select>
                </label>

                <label className="flex flex-col gap-2 text-sm">
                    <span className="font-semibold">Spot channels ({spotChannels})</span>
                    <input
                        type="range"
                        min="2"
                        max="8"
                        value={spotChannels}
                        disabled={mode !== 'spot'}
                        onChange={(e) => setSpotChannels(Number(e.target.value))}
                    />
                </label>

                <label className="flex flex-col gap-2 text-sm">
                    <span className="font-semibold">Dot size ({dotSize}px)</span>
                    <input type="range" min="5" max="22" value={dotSize} onChange={(e) => setDotSize(Number(e.target.value))} />
                </label>

                <label className="flex flex-col gap-2 text-sm">
                    <span className="font-semibold">Dot gain ({dotGain.toFixed(2)})</span>
                    <input
                        type="range"
                        min="0.45"
                        max="1.25"
                        step="0.05"
                        value={dotGain}
                        onChange={(e) => setDotGain(Number(e.target.value))}
                    />
                </label>
            </section>

            <section className="grid gap-6 xl:grid-cols-2">
                <article className="space-y-3">
                    <h2 className="text-xl">Overprint proof</h2>
                    <p className="text-sm text-neutral-400">Composite simulation with multiply-style ink stacking on white substrate.</p>
                    <canvas ref={proofCanvasRef} className="w-full rounded border border-neutral-800 bg-white" />
                </article>

                <article className="space-y-3">
                    <h2 className="text-xl">Source</h2>
                    <p className="text-sm text-neutral-400">Input artwork sampled for channel extraction.</p>
                    <canvas ref={sourceCanvasRef} className="w-full rounded border border-neutral-800 bg-neutral-900" />
                </article>
            </section>

            <section className="space-y-4">
                <div className="flex flex-wrap gap-2">
                    {layers.map((layer, index) => (
                        <button
                            key={`${layer.name}-${index}`}
                            type="button"
                            onClick={() => setActiveLayer(index)}
                            className={`btn ${activeLayer === index ? '' : 'opacity-65'}`}
                        >
                            <span className="h-3 w-3 rounded-full" style={{ backgroundColor: layer.hex }} />
                            {layer.name}
                        </button>
                    ))}
                </div>

                {active && (
                    <article className="space-y-4 rounded-lg border border-neutral-800 bg-neutral-950/80 p-4">
                        <header className="flex flex-wrap items-center justify-between gap-3">
                            <div>
                                <h3 className="text-lg font-semibold">{active.name} channel</h3>
                                <p className="text-sm text-neutral-400">Black film simulation + live overprint contribution controls.</p>
                            </div>
                            <span className="rounded px-2 py-1 text-xs font-semibold" style={{ backgroundColor: active.hex, color: '#111' }}>
                                {active.hex}
                            </span>
                        </header>

                        <div className="grid gap-4 md:grid-cols-3">
                            <label className="flex flex-col gap-2 text-sm">
                                <span className="font-semibold">Ink color</span>
                                <input
                                    className="h-10 w-full cursor-pointer rounded border border-neutral-700 bg-neutral-900 px-1"
                                    type="color"
                                    value={active.hex}
                                    onChange={(e) => updateLayer(activeLayer, { hex: e.target.value })}
                                />
                            </label>

                            <label className="flex flex-col gap-2 text-sm">
                                <span className="font-semibold">Screen angle ({active.angle}°)</span>
                                <input
                                    type="range"
                                    min="0"
                                    max="90"
                                    step="1"
                                    value={active.angle}
                                    onChange={(e) => {
                                        const value = Number(e.target.value);
                                        updateLayer(activeLayer, { angle: value });
                                        setAngles((prev) => {
                                            const next = [...prev];
                                            next[activeLayer] = value;
                                            return next;
                                        });
                                    }}
                                />
                            </label>

                            <label className="flex items-center gap-2 text-sm font-semibold">
                                <input
                                    type="checkbox"
                                    checked={active.enabled !== false}
                                    onChange={(e) => updateLayer(activeLayer, { enabled: e.target.checked })}
                                />
                                Include in overprint
                            </label>
                        </div>

                        <canvas ref={channelCanvasRef} className="w-full rounded border border-neutral-800 bg-white" />
                    </article>
                )}
            </section>

            <p className="text-sm text-neutral-400">{status}</p>
        </main>
    );
}

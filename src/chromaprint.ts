import { promises as fs } from 'node:fs';
import { createRequire } from 'node:module';

interface FingerprintResult {
    readonly compressed: string;
    free(): void;
}

interface ChromaprintBindings {
    __wbg_set_wasm(exports: WebAssembly.Exports): void;
    fingerprintFromSamples(sampleRate: number, channels: number, samples: Int16Array): FingerprintResult;
}

type WasmStart = () => void;

let bindingsPromise: Promise<ChromaprintBindings> | undefined;

/**
 * rusty-chromaprint-wasm is published with wasm-pack's `bundler` target, whose
 * default entry point imports the .wasm file as an ESM module. Node does not
 * support that import without an experimental flag, so instantiate the binary
 * explicitly and connect it to wasm-bindgen's generated JS glue instead.
 */
async function loadBindings(): Promise<ChromaprintBindings> {
    bindingsPromise ??= (async () => {
        const bindings = await import(
            'rusty-chromaprint-wasm/dist/rusty_chromaprint_wasm_bg.js'
        ) as unknown as ChromaprintBindings;
        const require = createRequire(import.meta.url);
        const wasmPath = require.resolve(
            'rusty-chromaprint-wasm/dist/rusty_chromaprint_wasm_bg.wasm',
        );
        const wasmBytes = await fs.readFile(wasmPath);
        const { instance } = await WebAssembly.instantiate(wasmBytes, {
            './rusty_chromaprint_wasm_bg.js': bindings as unknown as WebAssembly.ModuleImports,
        });

        bindings.__wbg_set_wasm(instance.exports);
        const start = instance.exports.__wbindgen_start as WasmStart | undefined;
        if (typeof start !== 'function') {
            throw new Error('Chromaprint WASM module does not export __wbindgen_start');
        }
        start();

        return bindings;
    })();

    return bindingsPromise;
}

export async function fingerprintFromSamples(
    sampleRate: number,
    channels: number,
    samples: Int16Array,
): Promise<string> {
    const bindings = await loadBindings();
    const result = bindings.fingerprintFromSamples(sampleRate, channels, samples);
    try {
        return result.compressed;
    } finally {
        result.free();
    }
}

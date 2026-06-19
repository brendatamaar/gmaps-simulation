import { readFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const wasmPath = path.join(__dirname, '../build/release.wasm');

const wasmBuffer = await readFile(wasmPath);
const { instance } = await WebAssembly.instantiate(wasmBuffer, {});
const { add } = instance.exports as { add: (a: number, b: number) => number };

const result = add(3, 4);
console.log(`add(3, 4) = ${result}`);
console.log(result === 7 ? 'PASS — AssemblyScript toolchain works' : 'FAIL');

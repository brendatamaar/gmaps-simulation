// Static hosting caps a single file at 25 MiB and has no compression for binary files, but graph.bin /
// ch.bin / alt.bin are 50-90 MB. The deployed copy ships them packed (labs/scripts/pack-data.mjs): the
// bytes of each array rearranged so gzip squeezes them ~2x, then gzipped and cut into parts listed in
// chunks.json. This fetches the parts in parallel, reverses the packing and hands back one Response, so
// callers use it exactly like fetch(). Without chunks.json (local dev, files served whole from
// web/public) it is a plain fetch.
export type Progress = (done: number, total: number) => void;

/** [from, len, width, delta]: `len` bytes at `from` were split into `width` byte planes (int32 delta first when `delta`). */
type Op = [number, number, number, number];
type Manifest = Record<
  string,
  { size: number; codec?: 'gzip'; transform?: Op[]; parts: { name: string; size: number }[] }
>;

let manifest: Promise<Manifest> | null = null;

function getManifest(): Promise<Manifest> {
  manifest ??= fetch('chunks.json')
    .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? (r.json() as Promise<Manifest>) : {}))
    .catch(() => ({}));
  return manifest;
}

// One part, streamed so progress is live; retried because 8 MB over a flaky mobile link can stall.
async function fetchPart(name: string, onBytes: (n: number) => void, tries = 3): Promise<Blob> {
  for (let attempt = 1; ; attempt++) {
    let got = 0;
    try {
      const r = await fetch(name);
      if (!r.ok || !r.body) throw new Error(`${name}: ${r.status}`);
      const reader = r.body.getReader();
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value as Uint8Array<ArrayBuffer>);
        got += value.length;
        onBytes(value.length);
      }
      return new Blob(chunks);
    } catch (err) {
      onBytes(-got);
      if (attempt >= tries) throw err;
    }
  }
}

/** Reverses pack-data.mjs in place. */
export function unpack(bytes: Uint8Array, ops: Op[]): void {
  for (const [from, len, w, delta] of ops) {
    const n = len / w;
    const planes = bytes.slice(from, from + len);
    for (let k = 0; k < w; k++) {
      const base = k * n;
      for (let i = 0; i < n; i++) bytes[from + i * w + k] = planes[base + i]!;
    }
    if (delta) {
      const a = new Int32Array(bytes.buffer, bytes.byteOffset + from, len / 4);
      for (let i = 1; i < a.length; i++) a[i] = (a[i]! + a[i - 1]!) | 0;
    }
  }
}

export async function fetchAsset(name: string, onProgress?: Progress): Promise<Response> {
  const entry = (await getManifest())[name];
  if (!entry) return fetch(name);

  const total = entry.parts.reduce((s, p) => s + p.size, 0);
  let done = 0;
  const blobs = await Promise.all(
    entry.parts.map((p) =>
      fetchPart(p.name, (n) => {
        done += n;
        onProgress?.(done, total);
      }),
    ),
  );

  const packed = new Blob(blobs);
  const buf =
    entry.codec === 'gzip'
      ? await new Response(packed.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
      : await packed.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes.length !== entry.size) throw new Error(`${name}: expected ${entry.size} bytes, got ${bytes.length}`);
  if (entry.transform) unpack(bytes, entry.transform);
  return new Response(bytes);
}

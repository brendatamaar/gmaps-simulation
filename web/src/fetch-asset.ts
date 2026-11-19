// Static hosting caps a single file at 25 MiB, but graph.bin / ch.bin / alt.bin are bigger. The
// deployed copy ships them as ≤20 MiB parts listed in chunks.json; this fetches the parts and hands
// back one Response, so callers use it exactly like fetch(). Without chunks.json (local dev, files
// served whole from web/public) it is a plain fetch.
type Manifest = Record<string, { size: number; parts: string[] }>;

let manifest: Promise<Manifest> | null = null;

function getManifest(): Promise<Manifest> {
  manifest ??= fetch('chunks.json')
    .then((r) => (r.ok && (r.headers.get('content-type') ?? '').includes('json') ? (r.json() as Promise<Manifest>) : {}))
    .catch(() => ({}));
  return manifest;
}

export async function fetchAsset(name: string): Promise<Response> {
  const entry = (await getManifest())[name];
  if (!entry) return fetch(name);
  const responses = await Promise.all(entry.parts.map((p) => fetch(p)));
  const failed = responses.find((r) => !r.ok);
  if (failed) return failed;
  const blobs = await Promise.all(responses.map((r) => r.blob()));
  return new Response(new Blob(blobs));
}

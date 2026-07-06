// Binary min-heap on typed arrays (Int32 payloads, Float64 keys). Replaces the
// number[]-pair heaps in the hot routing loops: no per-push allocation, no GC
// churn, stable element types for the JIT. Grows by doubling; clear() is O(1)
// so one instance persists across queries.
export class TypedMinHeap {
  private ns: Int32Array;
  private ks: Float64Array;
  private n = 0;

  constructor(capacity = 1024) {
    this.ns = new Int32Array(capacity);
    this.ks = new Float64Array(capacity);
  }

  get size(): number { return this.n; }

  clear(): void { this.n = 0; }

  // Min key without popping; Infinity when empty.
  peekKey(): number { return this.n > 0 ? this.ks[0]! : Infinity; }

  push(node: number, key: number): void {
    if (this.n === this.ns.length) this.grow();
    const { ns, ks } = this;
    let i = this.n++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (ks[p]! <= key) break;
      ns[i] = ns[p]!; ks[i] = ks[p]!;
      i = p;
    }
    ns[i] = node; ks[i] = key;
  }

  // Pops the min node. Read its key with peekKey() BEFORE calling. Caller must
  // check size > 0 first.
  pop(): number {
    const { ns, ks } = this;
    const top = ns[0]!;
    const last = --this.n;
    if (last > 0) {
      const node = ns[last]!, key = ks[last]!;
      let i = 0;
      while (true) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        let mk = key;
        if (l < last && ks[l]! < mk) { m = l; mk = ks[l]!; }
        if (r < last && ks[r]! < mk) { m = r; }
        if (m === i) break;
        ns[i] = ns[m]!; ks[i] = ks[m]!;
        i = m;
      }
      ns[i] = node; ks[i] = key;
    }
    return top;
  }

  private grow(): void {
    const cap = this.ns.length * 2;
    const ns = new Int32Array(cap);
    const ks = new Float64Array(cap);
    ns.set(this.ns); ks.set(this.ks);
    this.ns = ns; this.ks = ks;
  }
}

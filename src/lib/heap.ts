// Min-heap backed by two parallel number[] arrays (no per-push object allocation).
export class MinHeap {
  private ns: number[] = [];
  private fs: number[] = [];

  push(node: number, f: number): void {
    let i = this.ns.length;
    this.ns.push(node);
    this.fs.push(f);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.fs[p]! <= f) break;
      this._swap(p, i);
      i = p;
    }
  }

  pop(): { node: number; f: number } | undefined {
    if (this.ns.length === 0) return undefined;
    const node = this.ns[0]!, f = this.fs[0]!;
    const last = this.ns.length - 1;
    if (last > 0) {
      this.ns[0] = this.ns[last]!;
      this.fs[0] = this.fs[last]!;
    }
    this.ns.length = last;
    this.fs.length = last;
    let i = 0;
    while (true) {
      const l = 2 * i + 1, r = l + 1, n = this.ns.length;
      let min = i;
      if (l < n && this.fs[l]! < this.fs[min]!) min = l;
      if (r < n && this.fs[r]! < this.fs[min]!) min = r;
      if (min === i) break;
      this._swap(min, i);
      i = min;
    }
    return { node, f };
  }

  get size(): number { return this.ns.length; }
  peekF(): number { return this.ns.length > 0 ? this.fs[0]! : Infinity; }

  private _swap(a: number, b: number): void {
    const tn = this.ns[a]!, tf = this.fs[a]!;
    this.ns[a] = this.ns[b]!; this.fs[a] = this.fs[b]!;
    this.ns[b] = tn; this.fs[b] = tf;
  }
}

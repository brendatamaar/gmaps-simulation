export class MinHeap {
  private data: Array<{ node: number; f: number }> = [];

  push(node: number, f: number): void {
    this.data.push({ node, f });
    this.siftUp(this.data.length - 1);
  }

  pop(): { node: number; f: number } | undefined {
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  get size(): number { return this.data.length; }

  private siftUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.data[p]!.f <= this.data[i]!.f) break;
      [this.data[p], this.data[i]] = [this.data[i]!, this.data[p]!];
      i = p;
    }
  }

  private siftDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let min = i;
      const l = 2 * i + 1, r = 2 * i + 2;
      if (l < n && this.data[l]!.f < this.data[min]!.f) min = l;
      if (r < n && this.data[r]!.f < this.data[min]!.f) min = r;
      if (min === i) break;
      [this.data[i], this.data[min]] = [this.data[min]!, this.data[i]!];
      i = min;
    }
  }
}

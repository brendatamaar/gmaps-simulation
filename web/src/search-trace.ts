// Records the order in which a search settled nodes, for replay as a
// frontier-expansion animation. `side` distinguishes the forward search
// (from origin) from the backward search (from destination) in the
// bidirectional A*+ALT router; it's all zeros for the single-direction WASM A*.
export type SearchTrace = {
  order: Int32Array;
  side: Uint8Array;
};

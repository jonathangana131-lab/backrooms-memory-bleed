export function worldToCell(w: number): number {
  return Math.floor(w / CELL);
}
export function cellToWorld(c: number): number {
  return (c + 0.5) * CELL;
}
export function worldToChunk(w: number): number {
  return Math.floor(w / CHUNK_SIZE);
}



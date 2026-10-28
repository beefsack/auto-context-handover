// Shared seed-size helper. Node-free; imported by source/measure.ts and
// hooks/child.ts so both adapters share one boundary.
export function seedTooLarge(seedEstimate: number, softTokens: number): boolean {
  return seedEstimate > softTokens * 0.5
}

import { randomInt } from "node:crypto";

// Human-readable aggregator reference, e.g. PAY_847293.
// Uniqueness is ultimately guaranteed by the UNIQUE constraint on the column;
// this just makes collisions vanishingly unlikely.
export function generateAggregatorReference(): string {
  const n = randomInt(100000, 1000000); // 6 digits
  return `PAY_${n}`;
}

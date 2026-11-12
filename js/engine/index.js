// Public API of the workout engine. Pure functions only: the caller passes the library,
// equipment, history, seed, and time.

export { hashString, toSeed, mulberry32, makeRng } from './rng.js';
export {
  isEligible, availableWeights, weightSource, nextWeight, previousWeight, mapToAvailable,
  mapWeightDown, stepDistance, fixedPairs, adjustableSettings, hasAdjustable, hasDumbbells,
  equipmentWeights, usesWeight, isWeightAvailable,
} from './equipment.js';
export { recommend, lastPerformance, EFFORTS } from './recommend.js';
export { itemVolume, blockVolume, sessionVolume, compareVolume } from './volume.js';
export { estimateSec, estimateMin, trimToLength, TRIM_STEPS, ALLOWED_LENGTHS } from './duration.js';
export {
  generateSession, reroll, nextDayType, pickTemplate, finisherOptions, finisherSetting,
  activeItems, allItems, REQUIRED_PATTERNS,
} from './generator.js';
export { validateSession, slotAlternatives } from './validate.js';
export { swapCandidates, swapSlot, musclePeers, sameMuscleGroup } from './swap.js';

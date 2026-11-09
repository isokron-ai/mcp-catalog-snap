/**
 * Wall-clock bounds in tests are generous on purpose: they exist to catch
 * pathological behavior (minutes, hangs), and the suite runs files in
 * parallel on loaded CI runners. Every bound is multiplied by TIME_SCALE
 * (default 4; MCS_TEST_TIME_SCALE overrides it).
 */
export const TIME_SCALE = Number(process.env['MCS_TEST_TIME_SCALE'] ?? 4);

/** A wall-clock bound in ms, scaled. */
export const budget = (ms: number): number => ms * TIME_SCALE;

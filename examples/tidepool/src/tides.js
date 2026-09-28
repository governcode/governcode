// Tide readings: one height (metres) per hour, and the turning points between them.

/** Parses "hour,height_m" CSV text into [{ hour, height }], skipping the header and blank lines. */
export function parse(text) {
  return text
    .split("\n")
    .slice(1)
    .filter((line) => line.trim())
    .map((line) => {
      const [hour, height] = line.split(",").map(Number);
      return { hour, height };
    });
}

/** High and low waters: readings higher (or lower) than both neighbours. */
export function turningPoints(readings) {
  const highs = [];
  const lows = [];
  for (let i = 1; i < readings.length - 2; i++) {
    const [prev, cur, next] = [readings[i - 1], readings[i], readings[i + 1]];
    if (cur.height > prev.height && cur.height > next.height) highs.push(cur);
    if (cur.height < prev.height && cur.height < next.height) lows.push(cur);
  }
  return { highs, lows };
}

/** The tidal range: highest minus lowest reading, in metres. */
export function range(readings) {
  const heights = readings.map((r) => r.height);
  return Math.max(...heights) - Math.min(...heights);
}

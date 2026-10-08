// X's own counter (twitter-text v3 config) so the editor and server agree.
import twttr from "twitter-text";

const V3 = {
  version: 3,
  maxWeightedTweetLength: 280,
  scale: 100,
  defaultWeight: 200,
  emojiParsingEnabled: true,
  transformedURLLength: 23,
  ranges: [
    { start: 0, end: 4351, weight: 100 },
    { start: 8192, end: 8205, weight: 100 },
    { start: 8208, end: 8223, weight: 100 },
    { start: 8242, end: 8247, weight: 100 },
  ],
};
const LONG = { ...V3, maxWeightedTweetLength: 25000 };

export type PostFormat = "single" | "long" | "thread";

export function limitFor(format: PostFormat): number {
  return format === "long" ? 25000 : 280;
}

export function countPost(text: string, format: PostFormat = "single") {
  const parsed = twttr.parseTweet(text, format === "long" ? LONG : V3);
  const limit = limitFor(format);
  return { weightedLength: parsed.weightedLength, limit, over: parsed.weightedLength > limit, near: limit - parsed.weightedLength <= 10 };
}

export function weightedLength(text: string): number {
  return twttr.parseTweet(text, V3).weightedLength;
}

/** Index in `text` where the weighted count passes `limit` (for the long-post "Show more" cut). */
export function cutIndex(text: string, limit = 280): number {
  const parsed = twttr.parseTweet(text, { ...V3, maxWeightedTweetLength: limit });
  return parsed.valid ? text.length : parsed.validRangeEnd + 1;
}

export function findUrls(text: string) {
  return twttr.extractUrlsWithIndices(text);
}

export function findEntities(text: string) {
  return twttr.extractEntitiesWithIndices(text);
}

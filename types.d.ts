declare module "twitter-text" {
  export interface ParsedTweet { weightedLength: number; valid: boolean; permillage: number; validRangeStart: number; validRangeEnd: number; displayRangeStart: number; displayRangeEnd: number }
  export function parseTweet(text: string, config?: unknown): ParsedTweet;
  export function extractUrlsWithIndices(text: string): { url: string; indices: [number, number] }[];
  export function extractHashtags(text: string): string[];
  export function extractMentions(text: string): string[];
  export function extractEntitiesWithIndices(text: string): { url?: string; hashtag?: string; screenName?: string; cashtag?: string; indices: [number, number] }[];
  export const configs: { version3: Record<string, unknown> };
  const _default: { parseTweet: typeof parseTweet; extractUrlsWithIndices: typeof extractUrlsWithIndices; extractEntitiesWithIndices: typeof extractEntitiesWithIndices; extractHashtags: typeof extractHashtags; extractMentions: typeof extractMentions; configs: typeof configs };
  export default _default;
}

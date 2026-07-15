/**
 * Caveman Mode — inject terse-style system prompt to reduce output tokens.
 * Inspired by 9Router/Caveman. 5 intensity levels.
 */

import { getProxyConfig } from '@/config/manager';

const CAVEMAN_PROMPTS: Record<number, string> = {
  1: 'Be concise. Avoid filler words. Get to the point.',
  2: 'Be very concise. Short sentences. No pleasantries. Technical substance only.',
  3: 'Ultra concise. Telegraphic style. No filler. No preamble. Code speaks louder than words. Minimal explanation — only when non-obvious.',
  4: 'Extreme brevity. Bullet points over paragraphs. One-liners over explanations. Skip "here\'s what I did" — just show the result. Why use many word when few word do trick.',
  5: 'Maximum compression. No prose. No greetings. No summaries unless asked. Raw output only. Code diff > explanation. If it can be said in 3 words, don\'t use 4.',
};

/**
 * Returns the caveman system prompt to prepend, or empty string if disabled.
 */
export function getCavemanPrompt(): string {
  const config = getProxyConfig();
  if (!config.caveman?.enabled) return '';
  const level = Math.min(5, Math.max(1, config.caveman.level || 3));
  return CAVEMAN_PROMPTS[level];
}

import type { IModelSpec, InputAudioFormat } from '@/core/interfaces';
import { shapeOf } from './shape';

/**
 * What Antigravity can deliver to a model, decided in one place so `/models` and the OpenAI mapper
 * cannot disagree about it.
 *
 * ## Why Claude models do not hear here
 *
 * Antigravity serves Claude through the same Gemini-shaped request as Gemini itself — the OpenAI
 * mapper builds `inlineData` parts either way, and Google translates them for Claude upstream. That
 * translation has nowhere to put audio: the Anthropic Messages API has `text`, `image` and
 * `document` blocks and nothing else. So audio is a Gemini-target capability, and a Claude target
 * refuses it before the request leaves rather than finding out what Google does with it.
 */

/**
 * `input_audio.format` → the MIME type Gemini's `inlineData` wants.
 *
 * `ogg` is the reason this map exists at all: Gemini native reads opus-in-ogg, so a Telegram or
 * WhatsApp voice note reaches the model without being transcoded. It is outside the OpenAI spec,
 * which is why the format list is declared per route in `/models` rather than assumed.
 */
export const AUDIO_MIME_TYPES: Record<InputAudioFormat, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
};

const AUDIO_FORMATS = Object.keys(AUDIO_MIME_TYPES) as InputAudioFormat[];

/**
 * Whether this route can deliver `input_audio` to the model: what its spec says it takes, from the
 * file types Google's own model list gives it (`config/model-specs.ts`), and never for a Claude model,
 * whatever a spec says (the translation above has nowhere to put it).
 */
export function carriesAudio(modelSpec: IModelSpec): boolean {
  if (shapeOf(modelSpec).anthropic) return false;
  return modelSpec.inputModalities ? modelSpec.inputModalities.includes('audio') : true;
}

/**
 * Stamp the route's modalities onto a spec.
 *
 * A spec keeps the modalities it states: the ones Google's list gave it, or an operator's. One that
 * states none — a model Google did not list — is given the route's: text and images, and audio
 * unless it is a Claude model. A Claude spec never declares audio, because the mapper will refuse it
 * and a declaration the mapper contradicts is worse than none.
 */
export function withRouteModalities(modelSpec: IModelSpec): IModelSpec {
  const { inputAudioFormats, ...rest } = modelSpec;
  const anthropic = shapeOf(modelSpec).anthropic;

  const stated = modelSpec.inputModalities ?? (anthropic ? ['text', 'image'] : ['text', 'image', 'audio']);
  const inputModalities = anthropic ? stated.filter((modality) => modality !== 'audio') : stated;

  // Formats only ride along with audio, so a spec can never list formats for a route that is deaf.
  return inputModalities.includes('audio')
    ? { ...rest, inputModalities, inputAudioFormats: inputAudioFormats ?? [...AUDIO_FORMATS] }
    : { ...rest, inputModalities };
}

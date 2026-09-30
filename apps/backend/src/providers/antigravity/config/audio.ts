import type { IModelSpec, InputAudioFormat } from '@/core/interfaces';

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
 * Whether the request goes to a Claude model behind Antigravity.
 *
 * Read from the upstream id, the same way the mapper and the executor already tell the two apart.
 */
export function targetsClaude(modelSpec: IModelSpec): boolean {
  return (modelSpec.upstreamModelId ?? modelSpec.modelId).toLowerCase().includes('claude');
}

/** Whether this route can deliver `input_audio` to the model. */
export function carriesAudio(modelSpec: IModelSpec): boolean {
  return !targetsClaude(modelSpec);
}

/**
 * Stamp the route's modalities onto a spec.
 *
 * A Gemini spec keeps any modalities an override set explicitly — an operator may know a particular
 * model cannot hear. A Claude spec never declares audio, override or not, because the mapper will
 * refuse it and a declaration the mapper contradicts is worse than none.
 */
export function withRouteModalities(modelSpec: IModelSpec): IModelSpec {
  const { inputAudioFormats, ...rest } = modelSpec;

  const inputModalities = carriesAudio(modelSpec)
    ? (modelSpec.inputModalities ?? ['text', 'image', 'audio'])
    : (modelSpec.inputModalities?.filter((modality) => modality !== 'audio') ?? ['text', 'image']);

  // Formats only ride along with audio, so a spec can never list formats for a route that is deaf.
  return inputModalities.includes('audio')
    ? { ...rest, inputModalities, inputAudioFormats: inputAudioFormats ?? [...AUDIO_FORMATS] }
    : { ...rest, inputModalities };
}

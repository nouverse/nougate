import type { IModelSpec, IProvider } from '@/core/interfaces';

/**
 * What a `/models` entry says about the input a route can deliver, in the wire's snake_case.
 *
 * Both protocols' listings add the same two fields, so a client learns whether a model can hear
 * before it sends audio rather than from a refusal. Nothing is invented here: a spec that declares
 * nothing lists nothing, which a client must read as "not declared" rather than "text only". The
 * spec is the provider's, so the answer is the route's — see `IModelSpec.inputModalities`.
 */
export function listedModalities(
  provider: IProvider,
  modelId: string,
): { input_modalities?: string[]; input_audio_formats?: string[] } {
  let spec: IModelSpec | null = null;
  try {
    spec = provider.getModelRegistry().getSpec(modelId);
  } catch {
    // A listing must not fail because one spec could not be read; that model just says nothing.
  }

  const fields: { input_modalities?: string[]; input_audio_formats?: string[] } = {};
  if (spec?.inputModalities?.length) {
    fields.input_modalities = [...spec.inputModalities];
  }
  if (spec?.inputAudioFormats?.length && spec.inputModalities?.includes('audio')) {
    fields.input_audio_formats = [...spec.inputAudioFormats];
  }
  return fields;
}

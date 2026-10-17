import type { IModelSpec, IProvider } from '@/core/interfaces';

/**
 * What a `/models` entry says about a route beyond its id, in the wire's snake_case.
 *
 * Both protocols' listings add the same fields: the input a route can deliver, so a client learns whether a model can
 * hear before it sends audio rather than from a refusal; and the context window, when the route knows it, so a client
 * budgets a conversation by the model's real size rather than its own guess (`IModelSpec.contextWindow`). Nothing is
 * invented here: a spec that declares nothing lists nothing, which a client must read as "not declared" rather than
 * "text only" or "small". The spec is the provider's, so the answer is the route's.
 */
export function listedSpec(
  provider: IProvider,
  modelId: string,
): { input_modalities?: string[]; input_audio_formats?: string[]; context_window?: number } {
  let spec: IModelSpec | null = null;
  try {
    spec = provider.getModelRegistry().getSpec(modelId);
  } catch {
    // A listing must not fail because one spec could not be read; that model just says nothing.
  }

  const fields: { input_modalities?: string[]; input_audio_formats?: string[]; context_window?: number } = {};
  if (spec?.inputModalities?.length) {
    fields.input_modalities = [...spec.inputModalities];
  }
  if (spec?.inputAudioFormats?.length && spec.inputModalities?.includes('audio')) {
    fields.input_audio_formats = [...spec.inputAudioFormats];
  }
  if (spec?.contextWindow !== undefined && Number.isInteger(spec.contextWindow) && spec.contextWindow > 0) {
    fields.context_window = spec.contextWindow;
  }
  return fields;
}

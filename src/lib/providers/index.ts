import type { ProviderAdapter } from "./types";
import { kieAdapter } from "./kie";
import { cometapiAdapter } from "./cometapi";

const ADAPTERS: Record<string, ProviderAdapter> = {
  kie: kieAdapter,
  cometapi: cometapiAdapter,
};

export function getAdapter(provider: string): ProviderAdapter {
  const a = ADAPTERS[provider];
  if (!a) throw new Error(`لا يوجد محوّل للمزود: ${provider}`);
  return a;
}

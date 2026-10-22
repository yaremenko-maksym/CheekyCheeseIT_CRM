import { Module } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { InferenceClient } from '@crm/inference'
import type { Env } from '../config/env'
import { buildInferenceConfig } from './build-inference-config'
import { InferenceModelResolverService } from './inference-model-resolver.service'
import { INFERENCE_CLIENT } from './inference.tokens'

@Module({
  providers: [
    InferenceModelResolverService,
    {
      provide: INFERENCE_CLIENT,
      useFactory: (cfg: ConfigService<Env, true>, resolver: InferenceModelResolverService) =>
        new InferenceClient(
          buildInferenceConfig({
            JEV_API_KEY: cfg.get('JEV_API_KEY', { infer: true }),
            OPENROUTER_API_KEY: cfg.get('OPENROUTER_API_KEY', { infer: true }),
            LOCAL_MODEL_URL: cfg.get('LOCAL_MODEL_URL', { infer: true }),
            LOCAL_MODEL_KEY: cfg.get('LOCAL_MODEL_KEY', { infer: true }),
            LOCAL_MODEL_NAME: cfg.get('LOCAL_MODEL_NAME', { infer: true }),
            INFERENCE_EXTRACTION_PROVIDER: cfg.get('INFERENCE_EXTRACTION_PROVIDER', {
              infer: true,
            }),
          }),
          {
            resolveOpenRouterModelId: () => resolver.getSelectedModelId(),
            onOpenRouterModelUnavailable: (id) => resolver.onModelUnavailable(id),
          },
        ),
      inject: [ConfigService, InferenceModelResolverService],
    },
  ],
  exports: [INFERENCE_CLIENT],
})
export class InferenceModule {}

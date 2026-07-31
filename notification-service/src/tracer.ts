import 'dotenv/config';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';

const otlpEndpoint =
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';

const sdk = new NodeSDK({
  serviceName: process.env.OTEL_SERVICE_NAME || 'notification-service',
  traceExporter: new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();

process.on('SIGTERM', () => {
  sdk.shutdown().finally(() => process.exit(0));
});

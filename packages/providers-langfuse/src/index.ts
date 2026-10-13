export {
  exporterConfig,
  tracesUrl,
  type ExporterConfig,
  type ExporterConfigInput,
} from './config.js';
export {
  createTraceExporter,
  observedEventLog,
  type ExporterDeps,
  type ExporterStats,
  type TraceExporter,
} from './exporter.js';
export { buildSpans, type OtlpSpan } from './spans.js';

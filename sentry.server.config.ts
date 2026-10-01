/**
 * Sentry — runtime Node (server components, route handlers, server actions).
 * Lo importa `instrumentation.ts` solo si hay `SENTRY_DSN`. Opciones (sampling
 * bajo, redacción de PII) en `lib/observability-config.ts`.
 */
import * as Sentry from "@sentry/nextjs";
import { sentryBaseOptions } from "@/lib/observability-config";

const options = sentryBaseOptions();
if (options) Sentry.init(options);

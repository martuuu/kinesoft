/**
 * Sentry — runtime edge (middleware). Lo importa `instrumentation.ts` solo si
 * hay `SENTRY_DSN`. No importa `lib/logger`/`lib/env` (Node-only): las opciones
 * y la redacción vienen de módulos puros.
 */
import * as Sentry from "@sentry/nextjs";
import { sentryBaseOptions } from "@/lib/observability-config";

const options = sentryBaseOptions();
if (options) Sentry.init(options);

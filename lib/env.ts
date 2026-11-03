import { z } from "zod";
import { REALTIME_DRIVERS } from "@/lib/realtime-constants";
import { ACCESS_ENFORCEMENTS, type AccessEnforcement } from "@/lib/tenant-access";
import { PLATFORM_MFA_ENFORCEMENTS, type PlatformMfaEnforcement } from "@/lib/platform-mfa-logic";

// IAM-0b: `.env.example` trae estas variables vacías (`EMAIL_TRANSPORT=""`).
// Un string vacío cuenta como "no seteada", no como un valor inválido: si no,
// copiar el example rompería el arranque en local.
const emptyAsUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

// HF-1a (H-RT1, plan §22.2): Vercel guardó `SUPABASE_JWT_SECRET` con un `\n` al final (se pegó con Enter). Firmábamos
// el HS256 con ese byte de más, Supabase verificaba con el secreto limpio y TODO `phx_join` volvía con firma inválida:
// la agenda nunca entraba en vivo. El script local daba 11/11 porque dotenv recorta y Vercel no. Martin lo corrigió a
// mano; esto evita que vuelva: ningún secreto, `kid` ni clave pública tiene espacios legítimos en los bordes. Vacío
// (o solo espacios) → no seteada, igual que el resto. `lib/realtime-token-internal.ts` firma con `env`, así que el
// recorte llega a la firma sin más cambios.
const trimmedOrUndefined = (v: unknown) => (typeof v === "string" ? emptyAsUndefined(v.trim()) : v);

/**
 * WA (C-WA1): versión de la Graph API de Meta que usa `lib/whatsapp/graph.ts` si `WHATSAPP_GRAPH_VERSION` no está.
 * Constante en el código a propósito: subirla es un cambio revisado (sandbox antes), no un default que se mueve solo.
 */
export const WHATSAPP_GRAPH_VERSION_DEFAULT = "v23.0";
const WHATSAPP_GRAPH_VERSION_SHAPE = /^v\d{2}\.0$/;

// CF2 (D-CF2-12): forma de las claves VAPID (lo que emite `web-push generate-vapid-keys`). La pública es un punto P-256
// sin comprimir (65 bytes, el primero 0x04 → «B» en base64url); la privada, 32 bytes. Se valida acá y no importando
// `web-push` (pesa y es solo del server; este módulo también entra en bundles de cliente). El mensaje no trae la clave.
const VAPID_PUBLIC_SHAPE = /^B[A-Za-z0-9_-]{86}$/;
const VAPID_PRIVATE_SHAPE = /^[A-Za-z0-9_-]{43}$/;
function isVapidSubject(v: string): boolean {
  if (/^mailto:[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v)) return true;
  if (!/^https:\/\/\S+$/.test(v)) return false;
  try {
    return new URL(v).hostname.length > 0;
  } catch {
    return false;
  }
}
const WEB_PUSH_KEYS = ["WEB_PUSH_VAPID_PUBLIC_KEY", "WEB_PUSH_VAPID_PRIVATE_KEY", "WEB_PUSH_VAPID_SUBJECT"] as const;

const schema = z.object({
  DATABASE_URL: z.string().url().optional(),
  DIRECT_URL: z.string().url().optional(),
  // Service channel (BYPASSRLS) for surfaces without an Actor. Optional:
  // when unset, lib/db.ts falls back to DIRECT_URL (the owner connection).
  DATABASE_URL_SERVICE: z.string().url().optional(),

  NEXT_PUBLIC_SUPABASE_URL: z.string().url().optional(),
  // HF-1a: recortada (ver `trimmedOrUndefined`): viaja como `apikey` del socket y un `\n` lo rechaza igual.
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.preprocess(trimmedOrUndefined, z.string().optional()),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  // Sala de Espera en tiempo real (SV, §18.2). `off` (default) = la app es
  // idéntica a SR: ni publica ni abre sockets. `local` = bus en memoria + SSE,
  // solo para dev (en Vercel cada lambda tiene su propio bus: no entregaría
  // nada entre usuarios). `supabase` = Broadcast privado.
  REALTIME_DRIVER: z.enum(REALTIME_DRIVERS).default("off"),
  // Secreto HS256 con el que firmamos el token del canal (SV-D6/D15). SERVER-ONLY:
  // nunca `NEXT_PUBLIC_` (el guard (d) de SV lo verifica). Con él se puede firmar
  // un token `authenticated` del proyecto: es tan sensible como la service key.
  // HF-1a: recortado (H-RT1): un `\n` final de Vercel cambiaba la firma y ningún canal se suscribía.
  SUPABASE_JWT_SECRET: z.preprocess(trimmedOrUndefined, z.string().optional()),
  // `kid` opcional del header (SV-D15): con una clave HS256 del sistema nuevo de
  // JWT signing keys de Supabase hay que nombrarla; con el secreto legacy, no.
  SUPABASE_JWT_KID: z.preprocess(trimmedOrUndefined, z.string().optional()),

  MP_ACCESS_TOKEN: z.string().optional(),
  MP_PUBLIC_KEY: z.string().optional(),
  MP_WEBHOOK_SECRET: z.string().optional(),

  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  SENTRY_DSN: z.string().optional(),

  UPSTASH_REDIS_REST_URL: z.string().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),

  // Mail transaccional (IAM-0b, C-IAM1). La app manda todos los mails; Supabase
  // solo emite tokens. Opcional fuera de Production: `lib/email/transport.ts`
  // decide por dónde sale cada mail leyendo `process.env` en cada envío (no este
  // objeto, que se congela al importar y los tests no podrían cambiarlo); acá se
  // valida la forma, y RESEND_API_KEY + EMAIL_FROM están en REQUIRED_IN_PRODUCTION (HD-6).
  //   RESEND_API_KEY  SERVER-ONLY (nunca NEXT_PUBLIC_). Obligatoria en Production
  //                   (sin ella los mails irían a log y no saldrían).
  //   EMAIL_FROM      `<Marca> <no-reply@mail.dominio>`. Fuera de Production
  //                   hay default; en Production es obligatoria.
  //   EMAIL_TRANSPORT resend|mailpit|log. Solo pesa fuera de Production (dev:
  //                   mailpit o el opt-in de resend); Production lo ignora.
  //   EMAIL_REPLY_TO  default del Reply-To cuando el emisor no pasa uno.
  //   MAILPIT_URL     API HTTP de Mailpit (default http://localhost:8025).
  RESEND_API_KEY: z.preprocess(emptyAsUndefined, z.string().optional()),
  EMAIL_FROM: z.preprocess(emptyAsUndefined, z.string().optional()),
  EMAIL_TRANSPORT: z.preprocess(emptyAsUndefined, z.enum(["resend", "mailpit", "log"]).optional()),
  EMAIL_REPLY_TO: z.preprocess(emptyAsUndefined, z.string().optional()),
  // BO-Z: canal de soporte público (banda de acceso, /suspendido, Plan y uso). Lo lee lib/support-contact.ts.
  NEXT_PUBLIC_SUPPORT_EMAIL: z.preprocess(emptyAsUndefined, z.string().email().optional()),
  MAILPIT_URL: z.preprocess(emptyAsUndefined, z.string().url().optional()),

  // BO1-A (C-BO1, plan §19.5): despliegue del bloqueo por acceso del consultorio.
  //   off     = nada se corta (interruptor de emergencia).
  //   banner  = DEFAULT: la banda avisa (prueba, gracia, solo lectura) y solo se respeta la suspensión/baja
  //             explícita desde /plataforma. Prod es demo y hay consultorios en TRIALING vencido: no se los
  //             bloquea hasta que Martin lo decida.
  //   enforce = solo lectura real (transacciones read-only) y superficies públicas cerradas.
  // Los cortes leen `tenantAccessEnforcement()` (process.env en cada llamada), no este objeto congelado.
  TENANT_ACCESS_ENFORCEMENT: z.preprocess(
    emptyAsUndefined,
    z.enum(ACCESS_ENFORCEMENTS as unknown as [AccessEnforcement, ...AccessEnforcement[]]).default("banner")
  ),

  // BO4 (BO-D6, plan §19.5): verificación en dos pasos (TOTP de Supabase) para superadmins.
  //   off     = DEFAULT: Plataforma no la exige (las pantallas /plataforma-mfa igual funcionan para enrolarse).
  //             «Entrar como soporte» sigue permitido y el registro deja `mfa:false`.
  //   enforce = AAL2 para todo /plataforma y cada action de admin; re-verificación (10 min) en las de riesgo high.
  // Default off porque prenderlo antes de que el superadmin tenga un factor lo deja afuera de Plataforma (puede
  // configurarlo igual desde /plataforma-mfa/configurar, pero el orden es: enrolarse con off → probar → enforce).
  // Lo leen `platformMfaEnforcement()` (process.env en cada llamada) y `next.config.mjs` no: la CSP no depende de él.
  PLATFORM_MFA_ENFORCEMENT: z.preprocess(
    emptyAsUndefined,
    z
      .enum(PLATFORM_MFA_ENFORCEMENTS as unknown as [PlatformMfaEnforcement, ...PlatformMfaEnforcement[]])
      .default("off")
  ),

  // BO-Z (BO-D11, plan §19.5): alta web de consultorios.
  //   open     = DEFAULT: /signup crea consultorios nuevos. INF-ENV: nacen en prueba INDIVIDUAL (CONSULTORIO si el
  //              Titular no atiende, VX-Z) con los días de `SaasPlanConfig.trialDays` (`lib/onboarding.ts`). El «prueba
  //              PRO de 14 días» de BO-D1 ya no es cierto desde PL; el comentario viejo lo seguía diciendo.
  //   assisted = el alta la hace el equipo desde /plataforma: /signup muestra «escribinos» y el server rechaza
  //              crear un consultorio nuevo. Unirse por invitación sigue funcionando (no crea consultorio).
  // Lo lee `signupMode()` (process.env en cada llamada), no este objeto congelado.
  SIGNUP_MODE: z.preprocess(
    (v) => (typeof v === "string" ? emptyAsUndefined(v.trim().toLowerCase()) : v),
    z.enum(["open", "assisted"]).default("open")
  ),

  // BO3-E: secreto de los cron de Vercel (Authorization: Bearer). Opcional hasta BO5-A, que lo usa en el handler;
  // hoy solo lo lee `/plataforma/sistema` para mostrar presencia (nunca el valor).
  CRON_SECRET: z.preprocess(emptyAsUndefined, z.string().optional()),

  // BO5-B: modo mantenimiento (`lib/maintenance.ts`). Se prende con `on` + redeploy. El middleware NO lee este
  // objeto (importar `lib/env.ts` en el edge validaría todo el entorno en cada cold start): lee
  // `process.env.MAINTENANCE_MODE` con `maintenanceMode()`, que trata cualquier otro valor como `off`. Acá se valida
  // la forma (mayúsculas y espacios se toleran, igual que en el middleware), así un typo como `true` frena el
  // build del deploy en vez de dejar la app abierta creyendo que está en mantenimiento.
  //   MAINTENANCE_MESSAGE  línea opcional que ve CUALQUIERA en /mantenimiento: dato público, nada interno. Sin
  //                        tope acá a propósito: `maintenanceMessage()` la corta a 280 al mostrarla, y un mensaje
  //                        largo no puede frenar el deploy que justamente prende el mantenimiento.
  MAINTENANCE_MODE: z.preprocess(
    (v) => (typeof v === "string" ? emptyAsUndefined(v.trim().toLowerCase()) : v),
    z.enum(["off", "on"]).default("off")
  ),
  MAINTENANCE_MESSAGE: z.preprocess(emptyAsUndefined, z.string().optional()),

  // PL (PL-D16, plan §20.5.6): cobro de la suscripción SaaS de los consultorios.
  //   off    = DEFAULT: no se generan cargos ni se habla con MP; la app se deploya sin cobrar.
  //   manual = el cron genera cargos y Plataforma imputa pagos/comprobantes a mano (sin débito de MP).
  //   mp     = todo lo de `manual` (sigue «activo»: `billingActive()` de lib/saas-billing-internal.ts es `!== "off"`)
  //            Y ADEMÁS débito automático y «Pagar con MP» con el token de la plataforma (preapproval / checkout,
  //            MPS §26.6). INF-ENV (T6): deja de ser un alias de `manual`; lo que solo vale con MP pregunta
  //            `saasMpActive()`. Hasta PL-Z se trataba como `manual` (decisión del 16-oct, sin MP para la suscripción).
  //            En Production exige `MP_ACCESS_TOKEN` (y por la regla de abajo `MP_WEBHOOK_SECRET`): sin token no hay
  //            débito posible y el cobro quedaría «prendido» sin hacer nada.
  // Lo lee `saasBillingMode()` (process.env en cada llamada), no este objeto congelado. Mismo criterio de forma que
  // MAINTENANCE_MODE: un typo frena el deploy en vez de dejar el cobro en un modo que nadie eligió.
  SAAS_BILLING_MODE: z.preprocess(
    (v) => (typeof v === "string" ? emptyAsUndefined(v.trim().toLowerCase()) : v),
    z.enum(["off", "manual", "mp"]).default("off")
  ),
  // PL-Z (A2): datos para transferir (alias, CBU, titular, CUIT), texto libre. INF-ENV lo suma al schema solo para que
  // figure en el inventario (`.env.example`, DEPLOYMENT): sin forma, porque lo lee `saasBillingTransferInfo()` en cada
  // llamada y lo corta a 500; validarlo acá podría frenar un deploy por un texto.
  SAAS_BILLING_TRANSFER_INFO: z.preprocess(emptyAsUndefined, z.string().optional()),
  // MPS (C-MPS2, S5): piso del débito automático en centavos. Opcional: sin ella vale `MP_MIN_DEBIT_CENTS` de
  // `lib/saas-mp-logic.ts` (1500). Entero positivo, sin decimales ni notación científica (plata en centavos `Int`).
  // Lo lee `mpMinDebitCents()` en cada llamada. Un valor roto frena el deploy: un mínimo mal leído cobra de más o de menos.
  MP_MIN_DEBIT_CENTS: z.preprocess(
    (v) => (typeof v === "string" ? emptyAsUndefined(v.trim()) : v),
    z
      .string()
      .regex(/^[1-9]\d{0,8}$/, "entero positivo en centavos (p. ej. 1500 = $ 15)")
      .transform((s) => Number(s))
      .optional()
  ),
  // MPS-D9: cómo se entera la app del pago de un checkout SaaS.
  //   scope = DEFAULT: el checkout lleva `notification_url …/api/webhooks/mercadopago?scope=saas` (rama propia).
  //   panel = sin `notification_url`: llega por el webhook configurado en el panel de MP (si S-x del sandbox muestra
  //           que la URL por preferencia no llega con la firma esperada).
  // Lo lee `saasMpCheckoutNotify()` en cada llamada. Un typo frena el deploy.
  SAAS_MP_CHECKOUT_NOTIFY: z.preprocess(
    (v) => (typeof v === "string" ? emptyAsUndefined(v.trim().toLowerCase()) : v),
    z.enum(["scope", "panel"]).default("scope")
  ),
  // PL (C-PL11): buzón del equipo de la plataforma que recibe el aviso de mensajes de consultorios y leads de la landing.
  // Opcional: sin él los mensajes quedan en /plataforma → Tickets y no sale el aviso por mail.
  PLATFORM_INBOX_EMAIL: z.preprocess(emptyAsUndefined, z.string().email().optional()),

  // DIR (C-DIR2, plan §20.10/§20.13): directorio público de profesionales y consultorios.
  //   off     = DEFAULT: /profesionales y /consultorios/* dan 404; sitemap, robots y landing como antes.
  //   preview = rutas vivas pero `noindex`, fuera del sitemap y sin link en la landing (revisión antes de abrir).
  //   public  = indexables, en el sitemap y con «Buscá un profesional» en la landing.
  // Lo lee `directoryMode()` (`lib/directory-mode.ts`, process.env en cada llamada), no este objeto congelado. Un typo
  // frena el deploy en vez de publicar en un modo que nadie eligió.
  DIRECTORY_MODE: z.preprocess(
    (v) => (typeof v === "string" ? emptyAsUndefined(v.trim().toLowerCase()) : v),
    z.enum(["off", "preview", "public"]).default("off")
  ),

  // TP-P4 (C-TP2, plan §25.4 «Modos»): cobros online con la cuenta de Mercado Pago DEL VENDEDOR (OAuth).
  //   off     = DEFAULT: nadie conecta cuentas ni se crea ningún cobro; no se habla con MP.
  //   fake    = simulador local (`lib/mp-connect/fake-mp.ts`, `/api/mp/fake/*`): `next dev`, vitest y el `next start`
  //             del E2E. NUNCA en Vercel: el boot lo rechaza con `VERCEL_ENV` o `VERCEL` (cualquier scope) y
  //             `mpConnectMode()` lo baja a `off`. Se guarda por Vercel y no por NODE_ENV porque el E2E corre
  //             `next start` con NODE_ENV=production (§25.2 #11).
  //   sandbox = app de MP con cuentas de prueba (`test_token=true`); live = cobros reales.
  // Lo lee `mpConnectMode()` (process.env en cada llamada), no este objeto congelado. Un typo frena el deploy.
  MP_CONNECT_MODE: z.preprocess(
    (v) => (typeof v === "string" ? emptyAsUndefined(v.trim().toLowerCase()) : v),
    z.enum(["off", "fake", "sandbox", "live"]).default("off")
  ),
  // Credenciales de la APLICACIÓN de MP (no de un vendedor). SERVER-ONLY. Recortadas por lo de HF-1a.
  MP_OAUTH_CLIENT_ID: z.preprocess(trimmedOrUndefined, z.string().optional()),
  MP_OAUTH_CLIENT_SECRET: z.preprocess(trimmedOrUndefined, z.string().optional()),
  // Secreto de «Webhooks» de la app de MP con el que se verifica la rama `?acct=` (el legado sigue con
  // MP_WEBHOOK_SECRET, AUDIT §5.4). El fake firma con este mismo.
  MP_CONNECT_WEBHOOK_SECRET: z.preprocess(trimmedOrUndefined, z.string().optional()),
  // §25.2 #8 (S3): la doc no dice si los pagos con token de vendedor llegan firmados con el secreto de la app.
  //   required   = DEFAULT: sin firma válida → 401.
  //   fetch-only = se acepta sin firma; igual se vuelve a pedir el pago con el token de la cuenta y se chequean
  //                collector, referencia, monto y moneda (la rama es segura con o sin firma). Lo ajusta Martin tras S3.
  MP_CONNECT_WEBHOOK_SIGNATURE: z.preprocess(
    (v) => (typeof v === "string" ? emptyAsUndefined(v.trim().toLowerCase()) : v),
    z.enum(["required", "fetch-only"]).default("required")
  ),
  // C-TP1: claves del cifrado en reposo (`lib/secret-box.ts`), `k2:<b64 32 B>,k1:<b64 32 B>` (la primera sella).
  // Opcional (sin ella, en local, secret-box usa una clave dev determinista). Acá solo se valida la FORMA
  // (`secretBoxKeysShapeError`); el mensaje de error nunca trae la clave.
  SECRET_BOX_KEYS: z.preprocess(trimmedOrUndefined, z.string().optional()),

  // WA (C-WA1, brief §26.5): avisos por WhatsApp con el número de cada consultorio (Embedded Signup v4 de Meta).
  //   off     = DEFAULT: ningún aviso, ninguna query extra en los write paths de turnos, ningún request a Meta.
  //   fake    = simulador local (`lib/whatsapp/fake-graph.ts`, `/api/whatsapp/fake/*`): `next dev`, vitest y el
  //             `next start` del E2E. NUNCA en Vercel: el boot lo rechaza con `VERCEL_ENV` o `VERCEL` y `whatsappMode()`
  //             lo baja a `off` (mismo criterio y misma razón que MP_CONNECT_MODE=fake: el E2E corre con NODE_ENV=production).
  //   sandbox = app de Meta en modo desarrollo (números de prueba).
  //   live    = mensajes reales. En Preview se LEE como `off` (no un error): un «copiar de Production» en Vercel no
  //             puede dejar a un branch sin revisar mandando WhatsApps a pacientes reales.
  // Lo leen `whatsappMode()` / `fakeGraphAllowed()` (process.env en cada llamada). Un typo frena el deploy.
  WHATSAPP_MODE: z.preprocess(
    (v) => (typeof v === "string" ? emptyAsUndefined(v.trim().toLowerCase()) : v),
    z.enum(["off", "fake", "sandbox", "live"]).default("off")
  ),
  // Credenciales de la APP de Meta (no de un consultorio; el token de cada WABA va sellado con secret-box,
  // propósito `wa-credential`, `waCredentialAad`). SERVER-ONLY. Recortadas por lo de HF-1a: Meta firma el webhook con
  // el App Secret y un `\n` final invalidaría cada firma.
  WHATSAPP_APP_ID: z.preprocess(trimmedOrUndefined, z.string().optional()),
  WHATSAPP_APP_SECRET: z.preprocess(trimmedOrUndefined, z.string().optional()),
  // `config_id` de la configuración de Embedded Signup (Facebook Login for Business). No es secreto (viaja al browser
  // en el alta), pero sin él no hay alta posible.
  WHATSAPP_CONFIG_ID: z.preprocess(trimmedOrUndefined, z.string().optional()),
  // Lo que Meta manda en el GET de verificación del webhook (`hub.verify_token`). ≥ 32 en cualquier entorno: es lo
  // único que separa a cualquiera de suscribir NUESTRO endpoint a otra app. El mensaje de error no trae el valor.
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: z.preprocess(
    trimmedOrUndefined,
    z.string().min(32, "tiene que tener al menos 32 caracteres").optional()
  ),
  // Versión de la Graph API (`vNN.0`). Fija en un default del código para que un cambio de Meta no nos cambie el
  // contrato en silencio; se sube a mano, probando el sandbox. Solo `vNN.0` (Meta no publica menores).
  WHATSAPP_GRAPH_VERSION: z.preprocess(
    (v) => (typeof v === "string" ? emptyAsUndefined(v.trim()) : v),
    z
      .string()
      .regex(WHATSAPP_GRAPH_VERSION_SHAPE, "formato vNN.0 (p. ej. v23.0)")
      .default(WHATSAPP_GRAPH_VERSION_DEFAULT)
  ),
  // `featureType` del Embedded Signup. Vacía = alta clásica (número nuevo en la Cloud API). Con
  // `whatsapp_business_app_onboarding` el consultorio sigue usando la app WhatsApp Business del celular (coexistencia).
  WHATSAPP_SIGNUP_FEATURE: z.preprocess(
    (v) => (typeof v === "string" ? emptyAsUndefined(v.trim()) : v),
    z.enum(["whatsapp_business_app_onboarding"]).optional()
  ),

  // CF2 (§29, D-CF2-12, brief T.C «Env»): claves VAPID del push web a los profesionales («Avisos de turnos online»).
  // SERVER-ONLY las tres, también la pública: el navegador la recibe del server al suscribirse (`webPushVapid()`), así
  // que nunca `NEXT_PUBLIC_` (rotarla no pide redeploy del bundle). Se generan UNA vez con
  // `npx web-push generate-vapid-keys`; rotarlas deja mudos a todos los dispositivos ya suscriptos (sus suscripciones
  // quedan atadas a la pública vieja: el push service responde 401/403 y el sender las descarta a las 5 fallas).
  //   WEB_PUSH_VAPID_PUBLIC_KEY   punto P-256 sin comprimir, base64url sin relleno (87 caracteres, empieza con «B»).
  //   WEB_PUSH_VAPID_PRIVATE_KEY  escalar P-256, base64url sin relleno (43 caracteres).
  //   WEB_PUSH_VAPID_SUBJECT      `mailto:alguien@dominio` o `https://…`: el contacto que ven los push services (Apple
  //                               rechaza el push sin uno válido).
  // Regla (`webPushRules`): si hay una, las tres, en cualquier entorno. En Production sin ninguna solo se avisa
  // (RECOMMENDED_IN_PRODUCTION): sin push los avisos siguen saliendo por mail. Recortadas por lo de HF-1a.
  WEB_PUSH_VAPID_PUBLIC_KEY: z.preprocess(
    trimmedOrUndefined,
    z.string().regex(VAPID_PUBLIC_SHAPE, "no tiene forma de clave pública VAPID (base64url de 87, empieza con «B»)").optional()
  ),
  WEB_PUSH_VAPID_PRIVATE_KEY: z.preprocess(
    trimmedOrUndefined,
    z.string().regex(VAPID_PRIVATE_SHAPE, "no tiene forma de clave privada VAPID (base64url de 43)").optional()
  ),
  WEB_PUSH_VAPID_SUBJECT: z.preprocess(
    trimmedOrUndefined,
    z.string().refine(isVapidSubject, "tiene que ser mailto:alguien@dominio o una URL https://").optional()
  ),

  // Interruptores que ya se leían por `process.env` (INF-ENV los suma al schema para el inventario, sin validar la
  // forma: sus lectores ya tratan cualquier valor y frenar un deploy por ellos sería peor que el valor raro).
  //   SUPERADMIN_2FA_BYPASS        HF-3 (D-HF7): `<userId>@AAAA-MM-DD[,…]`; `lib/two-factor-bypass.ts` falla cerrado.
  //   NEXT_PUBLIC_PWA              MB-D6: `off` desregistra los service workers (`components/pwa/sw-register.tsx`).
  //   PATIENT_FILES_SIGNED_UPLOAD  FC-2f: `0`/`false`/`off` apaga la subida firmada (`lib/files.ts`).
  SUPERADMIN_2FA_BYPASS: z.preprocess(emptyAsUndefined, z.string().optional()),
  NEXT_PUBLIC_PWA: z.preprocess(emptyAsUndefined, z.string().optional()),
  PATIENT_FILES_SIGNED_UPLOAD: z.preprocess(emptyAsUndefined, z.string().optional()),

  // TP-0 (H-TP0/H-TP1, plan §22.5): ¿el turnero público cobra online al reservar?
  // TP-P4 (C-TP2): DEPRECADO. Queda en el enum para no romper un deploy con el valor ya cargado, pero el turnero de
  // T5 cobra con la cuenta del vendedor (MP_CONNECT_MODE) y ya no lo lee nadie; `platform` loguea un aviso al boot.
  //   off      = DEFAULT: el turno nace reservado sin pago y se paga en el consultorio. Hoy la ÚNICA cuenta de Mercado
  //              Pago es la de la plataforma (`MP_ACCESS_TOKEN`, AUDIT `turnero-mp-cuenta-plataforma`): cobrar online
  //              mandaría la plata del paciente a la plataforma y no al profesional. Además el checkout siempre exigía
  //              pagar y fallaba con precio $0, así que el turnero no dejaba terminar ninguna reserva.
  //   platform = se cobra con la cuenta de la plataforma (solo para probar o con acuerdo explícito), si además el monto
  //              llega al mínimo y MP está configurado (`decidePublicCheckout`).
  // TP-3z: `turneroCheckout()` se borró (nadie lo leía); solo queda el aviso de boot de abajo. Un typo frena el deploy.
  TURNERO_CHECKOUT: z.preprocess(
    (v) => (typeof v === "string" ? emptyAsUndefined(v.trim().toLowerCase()) : v),
    z.enum(["off", "platform"]).default("off")
  ),

  // OPS-1c (OPS-D1, plan §21.3): ref del proyecto Supabase de PRODUCCIÓN (no es secreto: es el subdominio de
  // `NEXT_PUBLIC_SUPABASE_URL`). Va en TODOS los scopes de Vercel con el mismo valor; solo lo usa el guard de Preview
  // (`previewTargetsProd`). Acá se acepta cualquier string a propósito: la forma se valida solo en Preview, así un
  // valor mal pegado nunca frena un deploy de Production.
  PROD_SUPABASE_REF: z.preprocess(
    (v) => (typeof v === "string" ? emptyAsUndefined(v.trim().toLowerCase()) : v),
    z.string().optional()
  ),

  // Set by Vercel: "production" | "preview" | "development". Unset locally/CI.
  VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
  // TP-P4: Vercel también setea `VERCEL=1` (build y runtime). Solo se mira para negar el simulador de MP: si por algún
  // camino faltara VERCEL_ENV, esta sola alcanza para que `fake` no arranque.
  VERCEL: z.string().optional(),
});

/**
 * TP-P4 (C-TP2): forma de `SECRET_BOX_KEYS` (`kid:<base64 de 32 bytes>`, separadas por coma, kids únicos). Se valida
 * acá con una copia mínima de la regla y no importando `parseSecretBoxKeys` de `lib/secret-box.ts`: ese módulo es
 * server-only (crypto) y `lib/env.ts` lo importan también módulos que terminan en bundles de cliente. El mensaje
 * nunca incluye la clave: el log del build de Vercel lo lee cualquiera con acceso al proyecto.
 */
export function secretBoxKeysShapeError(raw: string): string | null {
  const parts = raw.split(",").map((p) => p.trim());
  const seen = new Set<string>();
  for (const [i, part] of parts.entries()) {
    const idx = part.indexOf(":");
    const kid = idx > 0 ? part.slice(0, idx) : "";
    const b64 = idx > 0 ? part.slice(idx + 1).trim() : "";
    // Misma regla que `parseSecretBoxKeys` (TP-P1) y el CHECK de M18: kid `[a-z0-9_-]{1,16}`, `dev` reservado para la
    // clave de desarrollo. Si acá fuera más laxa, el boot pasaría y cada sello tiraría `bad_keys` en runtime.
    if (!/^[a-z0-9_-]{1,16}$/.test(kid)) return `entrada ${i + 1}: kid inválido (formato kid:<base64 de 32 bytes>, kid [a-z0-9_-]{1,16})`;
    if (kid === "dev") return "el kid «dev» está reservado para la clave de desarrollo";
    if (seen.has(kid)) return `kid «${kid}» repetido`;
    seen.add(kid);
    // base64 o base64url, exactamente 32 bytes.
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(b64) || Buffer.from(b64.replace(/-/g, "+").replace(/_/g, "/"), "base64").length !== 32) {
      return `la clave del kid «${kid}» no es base64 de 32 bytes`;
    }
  }
  return null;
}

/** TP-P4: «¿estamos en Vercel?» para el simulador. Cualquier valor (aun vacío) cuenta: ante la duda, sin fake. */
function onVercel(e: { VERCEL_ENV?: string; VERCEL?: string }): boolean {
  return e.VERCEL_ENV !== undefined || e.VERCEL !== undefined;
}

/** TP-P4 (C-TP2): reglas del modo de MP que valen en cualquier entorno y las de Production. */
function mpConnectRules(e: z.infer<typeof schema>, ctx: z.RefinementCtx): void {
  if (e.SECRET_BOX_KEYS) {
    const err = secretBoxKeysShapeError(e.SECRET_BOX_KEYS);
    if (err) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["SECRET_BOX_KEYS"], message: err });
  }
  if (e.MP_CONNECT_MODE === "fake" && onVercel(e)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["MP_CONNECT_MODE"],
      message: "\"fake\" (simulador local) no se permite en Vercel: usá \"off\", \"sandbox\" o \"live\"",
    });
  }
  if (e.VERCEL_ENV !== "production") return;
  if (e.MP_CONNECT_MODE !== "sandbox" && e.MP_CONNECT_MODE !== "live") return;
  // Sin client id/secret el callback no canjea ningún código; sin SECRET_BOX_KEYS secret-box se niega a sellar en
  // Vercel (no hay clave dev); sin el secreto con firma `required` el webhook nuevo daría 401 a todos los pagos.
  const required: (keyof z.infer<typeof schema>)[] = ["MP_OAUTH_CLIENT_ID", "MP_OAUTH_CLIENT_SECRET", "SECRET_BOX_KEYS"];
  if (e.MP_CONNECT_WEBHOOK_SIGNATURE === "required") required.push("MP_CONNECT_WEBHOOK_SECRET");
  for (const key of required) {
    if (!e[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `obligatoria en Production con MP_CONNECT_MODE=${e.MP_CONNECT_MODE}`,
      });
    }
  }
}

/**
 * WA (C-WA1): reglas de WHATSAPP_MODE. `fake` en Vercel frena el boot en cualquier scope (el simulador acepta
 * cualquier número y firma con un secreto conocido). En Production, `sandbox`/`live` sin App ID/Secret no canjean el
 * code del alta ni verifican la firma del webhook (todo 401), sin Config ID no abre el popup, sin Verify Token Meta no
 * deja suscribir el webhook y sin SECRET_BOX_KEYS secret-box se niega a sellar el token en Vercel: mejor que el deploy
 * no salga a que el alta falle en la cara del consultorio. Preview no exige nada: ahí `live` se lee como `off`.
 */
function whatsappRules(e: z.infer<typeof schema>, ctx: z.RefinementCtx): void {
  if (e.WHATSAPP_MODE === "fake" && onVercel(e)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["WHATSAPP_MODE"],
      message: "\"fake\" (simulador local de Meta) no se permite en Vercel: usá \"off\", \"sandbox\" o \"live\"",
    });
  }
  if (e.VERCEL_ENV !== "production") return;
  if (e.WHATSAPP_MODE !== "sandbox" && e.WHATSAPP_MODE !== "live") return;
  const required = [
    "WHATSAPP_APP_ID",
    "WHATSAPP_APP_SECRET",
    "WHATSAPP_CONFIG_ID",
    "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
    "SECRET_BOX_KEYS",
  ] as const;
  for (const key of required) {
    if (!e[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: `obligatoria en Production con WHATSAPP_MODE=${e.WHATSAPP_MODE}`,
      });
    }
  }
}

/**
 * CF2 (D-CF2-12): las claves VAPID van juntas, en cualquier entorno. Con una o dos el push no puede firmar (y una
 * pública sin su privada haría suscribir navegadores que nunca reciben nada): mejor que el deploy no salga a que la
 * pantalla diga «activado» y no llegue ningún aviso. Ninguna = push apagado (en Production, un aviso al boot).
 */
function webPushRules(e: z.infer<typeof schema>, ctx: z.RefinementCtx): void {
  const present = WEB_PUSH_KEYS.filter((k) => e[k]);
  if (present.length === 0 || present.length === WEB_PUSH_KEYS.length) return;
  for (const key of WEB_PUSH_KEYS) {
    if (e[key]) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message: `falta: las claves de push web van las tres juntas (hay ${present.join(", ")})`,
    });
  }
}

/**
 * OPS-1c · guard de Preview (OPS-D1). Por qué: hasta A0b los Preview compartían la base de prod y migraban (AUDIT
 * H6); el scope Preview → staging (OPS-0) se configura a mano en Vercel y un «copiar de Production» lo deshace sin que
 * nada avise. Con el guard, un build de Preview que apunta al proyecto de prod sale ROJO en vez de dejar un deploy
 * que escribe datos reales desde un branch sin revisar.
 *
 * Qué mira: host Y usuario de cada URL de base. El usuario importa: en el pooler de Supabase (Supavisor) el host es
 * compartido (`aws-0-<región>.pooler.supabase.com`) y el ref va en el usuario (`postgres.<ref>`): mirar solo el host
 * dejaba pasar justo la `DATABASE_URL` de prod. La contraseña, el path y la query no se miran (ni se imprimen).
 */
const PREVIEW_GUARDED_DB_KEYS = ["DATABASE_URL", "DIRECT_URL", "DATABASE_URL_SERVICE"] as const;
/** Los refs de Supabase son 20 caracteres [a-z0-9]; con un margen por si cambian, pero nunca algo corto como «prod». */
const SUPABASE_REF_SHAPE = /^[a-z0-9]{15,40}$/;

function urlMentionsRef(raw: string | undefined, ref: string): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw);
    return u.hostname.toLowerCase().includes(ref) || decodeURIComponent(u.username).toLowerCase().includes(ref);
  } catch {
    return false; // la forma de la URL ya la valida el schema
  }
}

function previewTargetsProd(e: z.infer<typeof schema>, ctx: z.RefinementCtx): void {
  if (e.VERCEL_ENV !== "preview" || !e.PROD_SUPABASE_REF) return;
  const ref = e.PROD_SUPABASE_REF;
  if (!SUPABASE_REF_SHAPE.test(ref)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["PROD_SUPABASE_REF"],
      message: "no tiene forma de ref de Supabase (20 letras/números, el subdominio de <ref>.supabase.co)",
    });
    return;
  }
  const hits: string[] = PREVIEW_GUARDED_DB_KEYS.filter((k) => urlMentionsRef(e[k], ref));
  if (urlMentionsRef(e.NEXT_PUBLIC_SUPABASE_URL, ref)) hits.push("NEXT_PUBLIC_SUPABASE_URL");
  for (const key of hits) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [key],
      message:
        "apunta al proyecto de PRODUCCIÓN (PROD_SUPABASE_REF) desde un deploy de Preview; " +
        "Preview tiene que usar staging (.docs/DEPLOYMENT.md «Guard de Preview»)",
    });
  }
}

/**
 * Fail-fast for the Production environment only (AUDIT 2026-09-23,
 * env-sin-fail-fast). Everything above is optional so local/CI builds work
 * with placeholders — which also meant a Production deploy missing
 * NEXT_PUBLIC_APP_URL shipped green and every invitation, password reset and
 * the Mercado Pago notification_url pointed at localhost:3000, and a missing
 * service key silently turned patient-file uploads into byte-less stubs.
 *
 * Keyed on VERCEL_ENV, NOT NODE_ENV: `next build` sets NODE_ENV=production in
 * CI too, and CI must keep building with placeholders.
 */
const REQUIRED_IN_PRODUCTION = [
  "DATABASE_URL",
  "DIRECT_URL",
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  // HD-6 (antes IAM-0b §19.9, un aviso): sin estas dos Production no manda NINGÚN mail (invitaciones, reset, portal)
  // porque `lib/email/transport.ts` cae a log, y el deploy salía verde igual: ahora lo frenan. Antes de prender esto en
  // Production hay que cargar el dominio de envío en Resend y las dos claves en Vercel. Solo con VERCEL_ENV=production (Preview, CI y el build local siguen sin exigirlas).
  "RESEND_API_KEY",
  "EMAIL_FROM",
] as const;

/** Still owner-pending (bucket C): logged loudly in prod, not fatal yet. */
const RECOMMENDED_IN_PRODUCTION = [
  "DATABASE_URL_SERVICE",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "SENTRY_DSN",
  // CF2 (D-CF2-12): sin ellas no sale ningún push («Avisos de turnos online» queda solo por mail).
  ...WEB_PUSH_KEYS,
] as const;

const productionSchema = schema.superRefine((e, ctx) => {
  previewTargetsProd(e, ctx);
  webPushRules(e, ctx);
  mpConnectRules(e, ctx);
  whatsappRules(e, ctx);
  if (e.VERCEL_ENV !== "production") return;
  // INF-ENV (C-MPS2): `mp` habla con MP con el token de la PLATAFORMA (preapproval y checkout de la suscripción). Sin
  // él, el cobro queda «prendido» sin poder debitar nada; el secreto lo exige la regla de abajo.
  if (e.SAAS_BILLING_MODE === "mp" && !e.MP_ACCESS_TOKEN) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["MP_ACCESS_TOKEN"],
      message: "obligatoria en Production con SAAS_BILLING_MODE=mp",
    });
  }
  for (const key of REQUIRED_IN_PRODUCTION) {
    // `.trim()`: un valor de solo espacios pegado en la consola de Vercel no es una clave (HD-6; Resend lo rechaza igual
    // y el mail se pierde en silencio).
    if (!e[key]?.trim()) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "obligatoria en Production" });
  }
  if (/localhost|127\.0\.0\.1/.test(e.NEXT_PUBLIC_APP_URL)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["NEXT_PUBLIC_APP_URL"],
      message: "no puede apuntar a localhost en Production (links de invitación/reset y webhook de MP)",
    });
  }
  // Without the secret the webhook answers 503 to every payment (AUDIT §5.4).
  if (e.MP_ACCESS_TOKEN && !e.MP_WEBHOOK_SECRET) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["MP_WEBHOOK_SECRET"],
      message: "obligatoria si MP_ACCESS_TOKEN está seteada",
    });
  }
  // SV-D11: con `supabase` sin secreto/URL/service key el publish falla en cada
  // action (breaker abierto) y nadie mintea tokens: la sala quedaría muda en
  // silencio. Mejor que el deploy no salga.
  // FX1b: también la anon key. `realtimeBootstrap` se la pasa al cliente como
  // `apikey` del socket; sin ella el browser no conecta y la sala cae a polling
  // sin que nada avise. Ya está en REQUIRED_IN_PRODUCTION, pero se repite acá a
  // propósito: si alguien la saca de esa lista (p. ej. al pasar a las claves
  // `sb_publishable_…`), el driver supabase no puede quedar sin ella.
  if (e.REALTIME_DRIVER === "supabase") {
    for (const key of [
      "SUPABASE_JWT_SECRET",
      "SUPABASE_SERVICE_ROLE_KEY",
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    ] as const) {
      if (!e[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: "obligatoria en Production con REALTIME_DRIVER=supabase",
        });
      }
    }
  }
  // SV-D11: el bus `local` vive en la memoria de UN proceso; en Vercel cada
  // lambda tiene el suyo y los eventos no cruzarían entre usuarios.
  if (e.REALTIME_DRIVER === "local") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["REALTIME_DRIVER"],
      message: "\"local\" no se permite en Production (usá \"supabase\" u \"off\")",
    });
  }
});

export type Env = z.infer<typeof schema>;

export function parseEnv(raw: Record<string, string | undefined>): Env {
  const r = productionSchema.safeParse(raw);
  if (!r.success) {
    const detail = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`[env] configuración inválida — ${detail}`);
  }
  // TP-P4 (C-TP2): el valor sigue aceptado para no frenar un deploy, pero ya no cobra nada. Es `console.warn` y no
  // `logger.warn` porque `lib/logger.ts` importa este módulo (ciclo); la línea lleva el mismo nombre de evento.
  if (r.data.TURNERO_CHECKOUT === "platform" && typeof window === "undefined") {
    console.warn(
      "[env] turnero_checkout.platform_ignored: TURNERO_CHECKOUT=platform ya no hace nada; el turnero cobra con la cuenta del profesional (MP_CONNECT_MODE)."
    );
  }
  // OPS-1c: sin el ref el guard no puede mirar nada. Aviso y no error: hasta que Martin lo cargue (OPS-0) un Preview
  // no puede caerse por eso.
  if (r.data.VERCEL_ENV === "preview" && !r.data.PROD_SUPABASE_REF && typeof window === "undefined") {
    console.warn("[env] Preview sin PROD_SUPABASE_REF: el guard contra la base de producción está apagado.");
  }
  if (r.data.VERCEL_ENV === "production" && typeof window === "undefined") {
    const missing = RECOMMENDED_IN_PRODUCTION.filter((k) => !r.data[k]);
    if (missing.length) {
      console.error(`[env] Production sin: ${missing.join(", ")} (tareas del dueño, ver .docs/EXTERNAL-CONFIG.md)`);
    }
  }
  return r.data;
}

export const env = parseEnv({
  DATABASE_URL: process.env.DATABASE_URL,
  DIRECT_URL: process.env.DIRECT_URL,
  DATABASE_URL_SERVICE: process.env.DATABASE_URL_SERVICE,
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  REALTIME_DRIVER: process.env.REALTIME_DRIVER,
  SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET,
  SUPABASE_JWT_KID: process.env.SUPABASE_JWT_KID,
  MP_ACCESS_TOKEN: process.env.MP_ACCESS_TOKEN,
  MP_PUBLIC_KEY: process.env.MP_PUBLIC_KEY,
  MP_WEBHOOK_SECRET: process.env.MP_WEBHOOK_SECRET,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  NODE_ENV: process.env.NODE_ENV,
  LOG_LEVEL: process.env.LOG_LEVEL,
  SENTRY_DSN: process.env.SENTRY_DSN,
  UPSTASH_REDIS_REST_URL: process.env.UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN: process.env.UPSTASH_REDIS_REST_TOKEN,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  EMAIL_FROM: process.env.EMAIL_FROM,
  EMAIL_TRANSPORT: process.env.EMAIL_TRANSPORT,
  EMAIL_REPLY_TO: process.env.EMAIL_REPLY_TO,
  MAILPIT_URL: process.env.MAILPIT_URL,
  NEXT_PUBLIC_SUPPORT_EMAIL: process.env.NEXT_PUBLIC_SUPPORT_EMAIL,
  VERCEL_ENV: process.env.VERCEL_ENV,
  TENANT_ACCESS_ENFORCEMENT: process.env.TENANT_ACCESS_ENFORCEMENT,
  CRON_SECRET: process.env.CRON_SECRET,
  MAINTENANCE_MODE: process.env.MAINTENANCE_MODE,
  MAINTENANCE_MESSAGE: process.env.MAINTENANCE_MESSAGE,
  PLATFORM_MFA_ENFORCEMENT: process.env.PLATFORM_MFA_ENFORCEMENT,
  SIGNUP_MODE: process.env.SIGNUP_MODE,
  SAAS_BILLING_MODE: process.env.SAAS_BILLING_MODE,
  PLATFORM_INBOX_EMAIL: process.env.PLATFORM_INBOX_EMAIL,
  DIRECTORY_MODE: process.env.DIRECTORY_MODE,
  TURNERO_CHECKOUT: process.env.TURNERO_CHECKOUT,
  MP_CONNECT_MODE: process.env.MP_CONNECT_MODE,
  MP_OAUTH_CLIENT_ID: process.env.MP_OAUTH_CLIENT_ID,
  MP_OAUTH_CLIENT_SECRET: process.env.MP_OAUTH_CLIENT_SECRET,
  MP_CONNECT_WEBHOOK_SECRET: process.env.MP_CONNECT_WEBHOOK_SECRET,
  MP_CONNECT_WEBHOOK_SIGNATURE: process.env.MP_CONNECT_WEBHOOK_SIGNATURE,
  SECRET_BOX_KEYS: process.env.SECRET_BOX_KEYS,
  VERCEL: process.env.VERCEL,
  PROD_SUPABASE_REF: process.env.PROD_SUPABASE_REF,
  // INF-ENV (T6+T7). `process.env.X` literal, una por una: Next inlinea `NEXT_PUBLIC_*` solo con el acceso literal.
  SAAS_BILLING_TRANSFER_INFO: process.env.SAAS_BILLING_TRANSFER_INFO,
  MP_MIN_DEBIT_CENTS: process.env.MP_MIN_DEBIT_CENTS,
  SAAS_MP_CHECKOUT_NOTIFY: process.env.SAAS_MP_CHECKOUT_NOTIFY,
  WHATSAPP_MODE: process.env.WHATSAPP_MODE,
  WHATSAPP_APP_ID: process.env.WHATSAPP_APP_ID,
  WHATSAPP_APP_SECRET: process.env.WHATSAPP_APP_SECRET,
  WHATSAPP_CONFIG_ID: process.env.WHATSAPP_CONFIG_ID,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN,
  WHATSAPP_GRAPH_VERSION: process.env.WHATSAPP_GRAPH_VERSION,
  WHATSAPP_SIGNUP_FEATURE: process.env.WHATSAPP_SIGNUP_FEATURE,
  SUPERADMIN_2FA_BYPASS: process.env.SUPERADMIN_2FA_BYPASS,
  NEXT_PUBLIC_PWA: process.env.NEXT_PUBLIC_PWA,
  PATIENT_FILES_SIGNED_UPLOAD: process.env.PATIENT_FILES_SIGNED_UPLOAD,
  WEB_PUSH_VAPID_PUBLIC_KEY: process.env.WEB_PUSH_VAPID_PUBLIC_KEY,
  WEB_PUSH_VAPID_PRIVATE_KEY: process.env.WEB_PUSH_VAPID_PRIVATE_KEY,
  WEB_PUSH_VAPID_SUBJECT: process.env.WEB_PUSH_VAPID_SUBJECT,
});

/**
 * INF-ENV (§26.7): las claves del schema, para el inventario de `.env.example` (lo verifica `tests/unit/inf-env.test.ts`)
 * y la tabla de env de `.docs/DEPLOYMENT.md`. Solo nombres: nunca valores.
 */
export const ENV_SCHEMA_KEYS: readonly string[] = Object.freeze(Object.keys(schema.shape));

/**
 * `TENANT_ACCESS_ENFORCEMENT` vigente, leído de `process.env` en cada llamada (como el transporte de mail): los
 * tests de integración lo cambian en caliente y `env` se congela al importar. Un valor inválido cae al default
 * `banner` (el boot ya lo rechazó en `parseEnv`; acá no se tira en medio de un request).
 */
export function tenantAccessEnforcement(): AccessEnforcement {
  const v = process.env.TENANT_ACCESS_ENFORCEMENT?.trim();
  return v === "off" || v === "banner" || v === "enforce" ? v : "banner";
}

/**
 * `PLATFORM_MFA_ENFORCEMENT` vigente (BO4), leído en cada llamada por la misma razón que el de arriba: los tests lo
 * cambian en caliente. Inválido o vacío → `off` (el boot ya rechazó un valor inválido; acá no se tira).
 */
export function platformMfaEnforcement(): PlatformMfaEnforcement {
  return process.env.PLATFORM_MFA_ENFORCEMENT?.trim() === "enforce" ? "enforce" : "off";
}

/**
 * `SIGNUP_MODE` vigente (BO-Z, BO-D11), leído en cada llamada: los tests lo cambian en caliente. Cualquier valor que
 * no sea `assisted` → `open` (el boot ya rechazó un valor inválido; acá no se tira en medio de un request).
 */
export function signupMode(): "open" | "assisted" {
  return process.env.SIGNUP_MODE?.trim().toLowerCase() === "assisted" ? "assisted" : "open";
}

export type SaasBillingMode = "off" | "manual" | "mp";

/**
 * `SAAS_BILLING_MODE` vigente (PL-D16), leído en cada llamada: los tests lo cambian en caliente. Cualquier valor que
 * no sea `manual` ni `mp` → `off` (el boot ya rechazó un valor inválido; acá no se tira en medio de un request ni del
 * cron, y ante la duda no se cobra). `mp` incluye todo lo de `manual`: quien pregunta «¿se cobra?» compara con `off`;
 * quien pregunta «¿hay Mercado Pago?» usa `saasMpActive()`.
 */
export function saasBillingMode(): SaasBillingMode {
  const v = process.env.SAAS_BILLING_MODE?.trim().toLowerCase();
  return v === "manual" || v === "mp" ? v : "off";
}

/**
 * INF-ENV (C-MPS2): ¿el cobro de la suscripción usa Mercado Pago (débito automático, «Pagar con MP», webhooks
 * `?scope=saas`)? Solo con `SAAS_BILLING_MODE=mp`. Desde T6 `mp` ya no es un alias de `manual`: esta es la pregunta
 * que cada superficie de MPS tiene que hacer antes de hablar con MP. Leído en cada llamada.
 */
export function saasMpActive(): boolean {
  return saasBillingMode() === "mp";
}

/**
 * `MP_MIN_DEBIT_CENTS` vigente (C-MPS2), leído en cada llamada. `null` = sin override: vale el default del código
 * (`MP_MIN_DEBIT_CENTS` de `lib/saas-mp-logic.ts`). Un valor inválido → `null` (el boot ya lo rechazó; acá no se tira
 * en medio del cron).
 */
export function mpMinDebitCents(): number | null {
  const v = process.env.MP_MIN_DEBIT_CENTS?.trim();
  return v && /^[1-9]\d{0,8}$/.test(v) ? Number(v) : null;
}

/** `SAAS_MP_CHECKOUT_NOTIFY` vigente (MPS-D9). Solo `panel` explícito cambia; cualquier otro valor → `scope`. */
export function saasMpCheckoutNotify(): "scope" | "panel" {
  return process.env.SAAS_MP_CHECKOUT_NOTIFY?.trim().toLowerCase() === "panel" ? "panel" : "scope";
}

export type WhatsappMode = "off" | "fake" | "sandbox" | "live";

/**
 * WA (C-WA1): `WHATSAPP_MODE` vigente, leído en cada llamada (los tests lo cambian en caliente; el outbox re-chequea
 * `mode === whatsappMode()` antes de cada envío). Inválido o vacío → `off`. `fake` fuera de lo permitido
 * (`fakeGraphAllowed()`) → `off`: el boot ya lo rechazó en Vercel, esta es la segunda barrera. `live` en Preview →
 * `off`: un Preview nunca le manda un WhatsApp real a un paciente, aunque alguien copie el env de Production.
 */
export function whatsappMode(): WhatsappMode {
  const v = process.env.WHATSAPP_MODE?.trim().toLowerCase();
  if (v === "sandbox") return v;
  if (v === "live") return process.env.VERCEL_ENV?.trim() === "preview" ? "off" : "live";
  if (v === "fake") return fakeGraphAllowed() ? "fake" : "off";
  return "off";
}

/**
 * WA (C-WA5): ¿puede responder el simulador de Meta (`/api/whatsapp/fake/*`)? Solo `WHATSAPP_MODE=fake` y fuera de
 * Vercel (ni `VERCEL_ENV` ni `VERCEL`, aun vacías). Como `fakeMpAllowed()`, NO mira NODE_ENV: el E2E corre `next start`.
 */
export function fakeGraphAllowed(): boolean {
  if (process.env.VERCEL_ENV !== undefined || process.env.VERCEL !== undefined) return false;
  return process.env.WHATSAPP_MODE?.trim().toLowerCase() === "fake";
}

/** WA (C-WA4): versión de la Graph API, leída en cada llamada. Sin forma `vNN.0` → el default del código. */
export function whatsappGraphVersion(): string {
  const v = process.env.WHATSAPP_GRAPH_VERSION?.trim();
  return v && WHATSAPP_GRAPH_VERSION_SHAPE.test(v) ? v : WHATSAPP_GRAPH_VERSION_DEFAULT;
}

/**
 * `SAAS_BILLING_TRANSFER_INFO` (PL-Z, A2): texto libre con los datos para transferir (alias, CBU, titular, CUIT).
 * Sin esto el consultorio no sabe a dónde pagar, así que sin él no se ofrece «Informar pago». Leído en cada llamada.
 */
export function saasBillingTransferInfo(): string | null {
  const v = process.env.SAAS_BILLING_TRANSFER_INFO?.trim();
  return v ? v.slice(0, 500) : null;
}

export type MpConnectMode = "off" | "fake" | "sandbox" | "live";

/**
 * TP-P4 (C-TP2): `MP_CONNECT_MODE` vigente, leído en cada llamada (los tests lo cambian en caliente). Inválido o vacío
 * → `off`. `fake` con `VERCEL_ENV` o `VERCEL` → `off`: el boot ya lo rechazó, pero esto es la segunda barrera por si
 * el proceso arrancó por otro camino; ante la duda no se habla con ningún MP.
 */
export function mpConnectMode(): MpConnectMode {
  const v = process.env.MP_CONNECT_MODE?.trim().toLowerCase();
  if (v === "sandbox" || v === "live") return v;
  if (v === "fake") return fakeMpAllowed() ? "fake" : "off";
  return "off";
}

/** TP-P4 (C-TP2): `MP_CONNECT_WEBHOOK_SIGNATURE` vigente. Solo `fetch-only` explícito relaja; cualquier otro → `required`. */
export function mpConnectSignatureMode(): "required" | "fetch-only" {
  return process.env.MP_CONNECT_WEBHOOK_SIGNATURE?.trim().toLowerCase() === "fetch-only" ? "fetch-only" : "required";
}

/**
 * TP-P4 (C-TP2/C-TP12): ¿puede responder el simulador de MP? Solo `MP_CONNECT_MODE=fake` y fuera de Vercel (ni
 * `VERCEL_ENV` ni `VERCEL`, aun vacías). NO se mira NODE_ENV: el E2E corre `next start` (production) con el fake.
 */
export function fakeMpAllowed(): boolean {
  if (process.env.VERCEL_ENV !== undefined || process.env.VERCEL !== undefined) return false;
  return process.env.MP_CONNECT_MODE?.trim().toLowerCase() === "fake";
}

/** `PLATFORM_INBOX_EMAIL` vigente (C-PL11), leído en cada llamada. Vacío → null (no sale el aviso por mail). */
export function platformInboxEmail(): string | null {
  const v = process.env.PLATFORM_INBOX_EMAIL?.trim();
  return v ? v : null;
}

/**
 * BO-Z (B3): ¿es el deploy de Production de Vercel? Leído en cada llamada (no de `env`, congelado al importar) para
 * que los tests puedan simularlo. Preview y local NO cuentan: ahí el soporte sin MFA sigue permitido para probar.
 */
export function isVercelProduction(): boolean {
  return process.env.VERCEL_ENV?.trim() === "production";
}

export type WebPushVapid = { publicKey: string; privateKey: string; subject: string };

/**
 * CF2 (D-CF2-12): claves VAPID vigentes, leídas de `process.env` en cada llamada (los tests las cambian en caliente y
 * `env` se congela al importar). `null` = push apagado: falta alguna o la forma no da (el boot ya lo rechazó; acá no se
 * tira en medio del submit del turnero). SOLO server: la privada nunca sale de acá (`lib/web-push-internal.ts`), y la
 * pública le llega al navegador por la action que arma la suscripción.
 */
export function webPushVapid(): WebPushVapid | null {
  const publicKey = process.env.WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.WEB_PUSH_VAPID_PRIVATE_KEY?.trim();
  const subject = process.env.WEB_PUSH_VAPID_SUBJECT?.trim();
  if (!publicKey || !privateKey || !subject) return null;
  if (!VAPID_PUBLIC_SHAPE.test(publicKey) || !VAPID_PRIVATE_SHAPE.test(privateKey) || !isVapidSubject(subject)) return null;
  return { publicKey, privateKey, subject };
}

export const isProd = env.NODE_ENV === "production";

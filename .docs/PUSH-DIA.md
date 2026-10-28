# Día del push · checklist único (23-oct-2026; PV, 27-oct)

> **El único checklist del día del push** de T3 → T7 + PV (§27) a producción. Reemplaza a [GO-LIVE-PASO-A-PASO.md](GO-LIVE-PASO-A-PASO.md)
> (14-oct, queda como historia). Todo lo que toca prod **lo corrés vos**: el agente nunca ejecuta nada contra prod
> (decisión 1 del 22-oct, plan §26.1). En cada paso marcado con 📋 **pegás la salida en el chat** y el agente la verifica
> antes de que sigas. Si algo da FAIL, frenás ahí.
>
> Detalle técnico de cada migración: [MIGRACIONES-RUNBOOK.md](MIGRACIONES-RUNBOOK.md) («M12 en prod» … «M16 en prod» y «M19 en prod»).
> Variables: [DEPLOYMENT.md «Variables de entorno»](DEPLOYMENT.md). Consolas: [EXTERNAL-CONFIG.md](EXTERNAL-CONFIG.md).
> Sin staging y sin reset: **precheck → backup → deploy de la base → push**.

`<ref>` = el project ref de Supabase de prod (el subdominio de `<ref>.supabase.co`, el mismo valor que `PROD_SUPABASE_REF`).

---

## A · Local (antes de tocar nada)

- [ ] Gate verde del cierre de PV (ZG; tsc, unit en TZ=UTC y AR, integración con los dos roles, E2E, `next build`
      aislado, `migrate deploy` en local = 47 migraciones).
- [ ] `git status` limpio y todo commiteado en `develop`.
- [ ] `git log --oneline main..develop | wc -l` → anotá cuántos commits salen (el 23-oct eran 185).
- [ ] `git diff --name-only main..develop -- prisma/migrations | grep migration.sql` → **exactamente estas 7**, en este
      orden (el que aplica `migrate deploy`, por timestamp):

  | # | Carpeta | Qué |
  |---|---|---|
  | M12 | `20261020120000_agenda_secretaria_config` | Secretaría: módulos a medida, tope de turnos, medio de pago del copago |
  | M14 | `20261021120000_fichas_clinicas` | Fichas clínicas, CIE-11, documentos del paciente |
  | M18 | `20261022120000_turnero_cobros_mp` | Cobros online con la cuenta de Mercado Pago del profesional |
  | M17 | `20261023120000_reception_displays` | Pantallas de TV de la sala |
  | M15 | `20261024120000_whatsapp_messaging` | Avisos por WhatsApp |
  | M16 | `20261025120000_saas_mp_subscriptions` | Suscripción con débito / Mercado Pago / transferencia, día 4 |
  | M19 | `20261027120000_support_tickets` | Tickets de soporte en /plataforma (origen, «Tomar», notas internas) |

  Todas aditivas y compatibles con el código que hoy está en prod: van **antes** del push.

## B · Variables de Vercel (Production), con los defaults seguros

Vercel → Project → Settings → Environment Variables → **Production**. Cargar o confirmar **antes** del push (el build
nuevo las valida al arrancar: un typo frena el deploy). Tabla completa en [DEPLOYMENT.md](DEPLOYMENT.md).

- [ ] `WHATSAPP_MODE=off` (o sin setear: el default es `off`).
- [ ] `SAAS_BILLING_MODE=off` (o sin setear).
- [ ] `MP_CONNECT_MODE=off` (o sin setear) y `MP_CONNECT_WEBHOOK_SIGNATURE=required` (o sin setear).
- [ ] `TURNERO_CHECKOUT` **sin setear** (deprecada: ya no la lee nadie).
- [ ] `DIRECTORY_MODE=off` (o sin setear).
- [ ] `SECRET_BOX_KEYS=k1:<base64 de 32 bytes>`, generada en tu terminal
      (`node -e "console.log('k1:'+require('crypto').randomBytes(32).toString('base64'))"`), guardada en el gestor de
      contraseñas. **Distinta** de la de Preview. Perderla = reconectar todas las cuentas de MP y WhatsApp.
- [ ] `PROD_SUPABASE_REF=<ref>` en **todos** los scopes (Production, Preview, Development), mismo valor.
- [ ] `CRON_SECRET` presente (ya estaba desde BO; si no: `openssl rand -hex 32`). Lo usan los **dos** crons.
- [ ] `REALTIME_DRIVER=supabase` (ya está; confirmá que siga y que estén `SUPABASE_JWT_SECRET`,
      `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL` y `_ANON_KEY`: con `supabase` el boot las exige).
- [ ] `NEXT_PUBLIC_APP_URL` = el dominio de prod (nunca localhost: el boot lo rechaza).
- [ ] **`RESEND_API_KEY` y `EMAIL_FROM` cargadas. Obligatorias desde HD-6 (PV): sin alguna de las dos el build de
      Production falla** (`REQUIRED_IN_PRODUCTION`, `lib/env.ts:69`; solo con `VERCEL_ENV=production`, Preview no).
      `EMAIL_FROM` con el nombre visible nuevo (`Consultorio Online <no-reply@mail.<dominio>>`; los mails salen como
      «<Consultorio> vía Consultorio Online»). Que estén no garantiza que salgan: el dominio verificado en Resend es G1.
      Mientras no esté verificado, `SIGNUP_MODE=assisted`.

**Lo que NO tiene que estar en Production** (borralo si aparece):

- [ ] `KINESOFT_ALLOW_DEMO_ACTOR` (bypass de login local).
- [ ] `WHATSAPP_MODE=fake` / `MP_CONNECT_MODE=fake` (el boot los rechaza en Vercel, pero mejor no tenerlos).
- [ ] `REALTIME_DRIVER=local` (el boot lo rechaza).
- [ ] `EMAIL_TRANSPORT`, `MAILPIT_URL`, `ALLOW_DEV_REMOTE_SUPABASE`, `ALLOW_DEV_REMOTE_DB`, `PERF_TIMING` (son de local).
- [ ] Cualquier literal de los simuladores (`dev-mpfake-…`, `FAKE-…`, `127.0.0.1`).
- [ ] `SUPERADMIN_2FA_BYPASS`, salvo que lo estés usando a propósito con fecha (falla cerrado, pero se borra al terminar).

## B2 · Antes de vender (PV, no frena el push)

> **Decisión de Martin (27-oct): prod se RESETEA antes de vender** (cuentas viejas y 2FA dan igual). Este documento
> todavía describe el camino incremental (migraciones M12 → … → M19 sobre la base actual): el procedimiento de reset
> (backup, base vacía, `migrate deploy` desde cero, roles, catálogo, superadmin, bootstrap) se planifica aparte con Martin
> antes del push. El gate legal de la app (LG-G) pide la casilla a todos al entrar.


- [ ] **`LEGAL_ENTITY`** en `lib/legal.ts:27` (razón social, CUIT, domicilio). Mientras estén en `null`, `/terminos` y
      `/privacidad` no muestran esa línea. Es un cambio de código: va en un commit antes del push o en uno después.
      Más la revisión del abogado (transferencias internacionales, registro de la base en la AAIP, consumo, retención).
- [ ] **Aviso de 2FA a quienes ya la enrolaron** (vos y el cliente vivo): la app de autenticación sigue mostrando la
      entrada con el nombre viejo («KineSoft»); los códigos funcionan igual. Las enrolaciones nuevas salen como
      «Consultorio Online» (`lib/two-factor.ts:190`). Si molesta, desenrolar y volver a enrolar desde Cuenta → Seguridad.
- [ ] Consolas de marca (Google OAuth, apps de MP y Meta): [EXTERNAL-CONFIG «Consolas de marca»](EXTERNAL-CONFIG.md#marca-pv).

## C · Consola mínima (Supabase de prod)

- [ ] Storage: buckets **privados** `patient-documents` (10 MB, solo `application/pdf`) y `billing-receipts` (4 MB, PDF e
      imágenes). Ya deberían estar `patient-files` y `practice-assets` (T4); el `--pre` los revisa a los cuatro
      ([EXTERNAL-CONFIG §0.11 y §0.6](EXTERNAL-CONFIG.md)).
- [ ] Settings → API → **Data API apagada** (o `public` fuera de los schemas expuestos). El `--pre` lo confirma
      (`dataapi.anon`).

## D · Base (en tu terminal, desde la raíz del repo)

- [ ] **D0 · `pg_dump` 17 en el PATH** (el tuyo es 14.18 y el server es más nuevo: el backup abortaría y el `--pre`
      lo marca FAIL):

  ```bash
  export PATH="/opt/homebrew/opt/postgresql@17/bin:$PATH"
  pg_dump --version            # → 17.x
  ```

- [ ] **D1 · 📋 Precheck** (una tx READ ONLY; imprime PASS/WARN/FAIL sin secretos):

  ```bash
  KINESOFT_CONFIRM_PROD=<ref> npm run db:prod:precheck -- --pre
  ```

  Tiene que terminar en `0 FAIL` (el script ya incluye M19: `pre.M19.absent`). **Anotá el `relfilenode` de Booking** que imprime (`pre.M18.relfilenode`): lo usás en
  D4. Los WARN esperables: `pre.M16.customPrice` (si hay precios a medida) y la distribución de `anchorDay`.
- [ ] **D2 · Backup:**

  ```bash
  npm run db:prod:backup       # → ~/kinesoft-backups/prod-<fecha>.dump (lista el archivo al final)
  ```

- [ ] **D3 · Deploy de la base** (aplica las 7 en orden M12 → M14 → M18 → M17 → M15 → M16 → M19):

  ```bash
  npm run db:prod:status       # → 7 pendientes
  npm run db:prod:deploy
  npm run db:prod:status       # → "Database schema is up to date!"
  ```

  Si da **P3009** por `lock_timeout` (alguna tx larga sobre Booking/Patient/Tenant): no reintentes a ciegas, pegá la
  salida (RUNBOOK §2.4 «Si falla: P3009»).
- [ ] **D4 · 📋 Postcheck:**

  ```bash
  KINESOFT_CONFIRM_PROD=<ref> npm run db:prod:precheck -- --post --booking-relfilenode=<el de D1>
  ```

  `0 FAIL` (incluye `post.M19.*`): objetos de las 7, md5 de `clinical_note_guard`, `patient_document_guard`, `online_charge_guard`,
  `online_charge_sync_booking` y `saas_adjustment_guard`, RLS/FORCE y policies, checksums y `migrate status` al día.

## E · Push y verificación

- [ ] Push `develop → main` (lo hacés vos). El build de Production corre `prisma migrate deploy`: con D3 hecho es un
      **no-op** (en el log: «No pending migrations to apply»).
- [ ] El build sale verde (si falla por una variable, el log nombra la variable; corregila y redeployá).
- [ ] Smoke en el dominio de prod:
  - [ ] login con tu cuenta y con la del cliente vivo;
  - [ ] `/agenda`: los turnos de siempre, crear y mover uno;
  - [ ] turnero público de un consultorio con turnos online: reservar (sin cobro, `MP_CONNECT_MODE=off`);
  - [ ] `/tv` en una ventana privada → pantalla de vínculo («Vinculá esta pantalla», pide el código);
  - [ ] `/pagar/x` → «No encontramos este link de pago» (es una página, no un 404 HTTP);
  - [ ] `curl -s -o /dev/null -w '%{http_code}\n' https://<dominio>/api/cron/daily` → `401` (y lo mismo con
        `/api/cron/whatsapp`); `503` = falta `CRON_SECRET`.
  - [ ] `/plataforma/sistema`: `CRON_SECRET` presente y «Cobros online (Mercado Pago)» en `off`.
  - [ ] PV: `/terminos` y `/privacidad` cargan; `/contacto` anónimo deja un ticket en `/plataforma/mensajes` («Tickets»);
        la pestaña dice «… · Consultorio Online».

## F · Scripts post-deploy (prod, los corrés vos)

- [ ] **F1 · Re-anclaje de suscripciones al día 4** (M16 cambió el default sin backfill). Con `SAAS_BILLING_MODE` en
      `off` y fuera de las 08:00 AR (cron diario):

  ```bash
  # dry-run (READ ONLY): 📋 pegá la tabla
  KINESOFT_CONFIRM_PROD=<ref> npx dotenv -e .env.prod.local -- \
    npx tsx --conditions=react-server scripts/saas-reanchor.ts
  # aplicar
  KINESOFT_CONFIRM_PROD=<ref> npx dotenv -e .env.prod.local -- \
    npx tsx --conditions=react-server scripts/saas-reanchor.ts --apply
  # dry-run otra vez: todo tiene que salir «skip» («todo está anclado al 4»)
  ```

  Opcional: `--tenant=<id>[,<id>…]`. No toca `autoDebitAllowed` (se desbloquea desde Plataforma si hace falta).
- [ ] **F2 · Consultorios QA** (los 8 `qa-<plan>-<vertical>`: individual / consultorio / clinica / libre × general /
      kinesiologia). Sumá a `.env.prod.local` (no en la línea de comando: queda en el historial)
      `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (del **mismo** proyecto que la base), `QA_EMAIL_BASE`
      (sin «+»), `QA_PASSWORD` (≥ 12) y `NEXT_PUBLIC_APP_URL`:

  ```bash
  Q='npx tsx --conditions=react-server scripts/qa-tenants.ts --target prod'
  KINESOFT_CONFIRM_PROD=<ref> npx dotenv -e .env.prod.local -- $Q --sample-data      # crea/re-alinea + tabla de accesos
  KINESOFT_CONFIRM_PROD=<ref> npx dotenv -e .env.prod.local -- $Q --state qa-individual-kinesiologia read-only
  #   estados: trial | trial-expired | read-only | past-due | suspended | active
  KINESOFT_CONFIRM_PROD=<ref> npx dotenv -e .env.prod.local -- $Q --cleanup          # al terminar el QA
  ```

  Es idempotente. El QA por plan está en [QA.md «QA de producción por plan»](QA.md).

## G · Activaciones posteriores (en este orden, cada una con su redeploy)

1. [ ] **Resend** (las variables ya están desde B; acá se verifica que salgan): diagnóstico del rechazo (`scripts/diagnose-email.ts --from-name "" --expect-domain <dominio>`) y la
       tarjeta «Últimos mails que no salieron» ([EXTERNAL-CONFIG §0.4 y §0.9](EXTERNAL-CONFIG.md)).
2. [ ] **Upstash** (`UPSTASH_REDIS_REST_URL/_TOKEN`, §4).
3. [ ] **Sentry** (`SENTRY_DSN`, §5) → **2 semanas** de reportes de CSP → CSP enforce global (hoy solo `/tv` es enforce).
4. [ ] **Google OAuth:** provider en Supabase de prod (§8). El código ya está.
5. [ ] **Suscripción:** precios en /plataforma + `SAAS_BILLING_TRANSFER_INFO` + bucket `billing-receipts` →
       `SAAS_BILLING_MODE=manual` → sandbox **S1-S10** (`diagnose:mp-subscriptions --sandbox`) → `mp` (§0.14).
6. [ ] **MP Connect:** app de MP → sandbox **S1-S11** → `MP_CONNECT_MODE=live` + pago real de $ 1 y su reintegro (§0.12).
7. [ ] **WhatsApp:** verificación del negocio en Meta → app y Embedded Signup → sandbox **S1-S13**
       (`diagnose:whatsapp --sandbox`) → `WHATSAPP_MODE=live` (§0.13).
8. [ ] **Spike de TV real** en el televisor de la sala (Chromecast / Fire TV o Chrome kiosco, §0.15).
9. [ ] Opcionales: roles RLS en prod (OPS-3: `kinesoft_app` sin BYPASSRLS + `kinesoft_service`) y staging (OPS-0).

## H · Rollback

- **Las 7 migraciones son aditivas:** el código viejo convive con ellas. Volver atrás el código **no** pide tocar la
  base. Sacar una migración = migración nueva con DROP (decide Martin; se pierde lo escrito desde el push; el backup de
  D2 es la red).
- **Código:** Vercel → Deployments → el deploy anterior → «Promote to Production» (inmediato), y después `git revert` del
  merge en `main` (lo hacés vos). El build del revert migra en vacío.
- **Sin código:** `WHATSAPP_MODE=off`, `SAAS_BILLING_MODE=off`, `MP_CONNECT_MODE=off`, `DIRECTORY_MODE=off`,
  `REALTIME_DRIVER=off`, `MAINTENANCE_MODE=on` como último recurso; cada cambio pide **redeploy**.
- Palancas por migración (triggers de M14/M18, `saas_adjustment_guard` de M16): RUNBOOK, paso «Rollback» de cada una.

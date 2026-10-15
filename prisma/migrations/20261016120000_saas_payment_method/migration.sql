-- M8c · saas_payment_method (bloque PL del §20, sesión PL-F0, va SOLA; 16-oct-2026).
-- Por qué:
--   • Decisión de Martin (16-oct): el medio de pago de la suscripción («cómo pagó»: transferencia, efectivo, tarjeta,
--     billetera, Mercado Pago u otro) va en una COLUMNA PROPIA de "SaasPayment", no escrito en la nota libre (`note`).
--     Con la nota no se puede filtrar, contar ni conciliar por medio, y la nota tiene otro uso (≤ 500 caracteres de
--     comentario del consultorio).
--   • `source` (MP_AUTO / MP_CHECKOUT / MANUAL) NO alcanza: dice POR QUÉ CANAL entró el pago al sistema, no con qué se
--     pagó. Un MANUAL puede ser transferencia, efectivo o tarjeta; por eso es una columna aparte y no se deriva.
-- Qué hace (aditiva, expand/contract):
--   • enum NUEVO "SaasPaymentMethod" (TRANSFER / CASH / CARD / WALLET / MERCADO_PAGO / OTHER).
--   • "SaasPayment"."method" NULLABLE, sin default. NULL = «sin informar». Las filas existentes quedan en NULL: NO se
--     backfillea desde `note` (texto libre: adivinar el medio desde la nota sería inventar un dato de plata).
--   • A propósito NO hay CHECK que ate `method` con `source` (p. ej. MP_* ⇒ MERCADO_PAGO): el código anterior a esta
--     migración inserta pagos sin `method`, y un CHECK así lo rompería durante la ventana de deploy (Vercel migra en
--     el build mientras el deploy viejo sigue sirviendo). Si hace falta, va en una migración posterior con backfill.
-- Compatibilidad: el código viejo no nombra la columna (Prisma lista columnas explícitas) y la columna es NULL sin
--   default, así que sus INSERT/SELECT siguen funcionando. Se puede aplicar antes del deploy que la use.
-- Lo que NO cambia: RLS de "SaasPayment" (TENANT_READONLY: ENABLE + FORCE + UNA policy FOR SELECT por tenant, M8), sus
--   CHECKs (amountCents, source_mp, receipt, notes), FKs e índices. "SaasPayment" no tiene trigger (los de solo
--   inserción de M8 son de "SaasPlanPriceChange" y "UserSecurityEvent"). Los privilegios de kinesoft_app son por
--   tabla, así que cubren la columna nueva; el tipo nuevo vive en `public` (USAGE de PUBLIC por defecto).
-- Locks: `CREATE TYPE` no bloquea tablas; `ADD COLUMN` NULL sin default es solo catálogo (no reescribe la tabla) pero
--   toma ACCESS EXCLUSIVE un instante sobre "SaasPayment": `lock_timeout` 5 s para no quedar encolado detrás de una
--   transacción larga (si salta, se reintenta; la tx entera vuelve atrás).
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TYPE "SaasPaymentMethod" AS ENUM ('TRANSFER', 'CASH', 'CARD', 'WALLET', 'MERCADO_PAGO', 'OTHER');

ALTER TABLE "SaasPayment" ADD COLUMN "method" "SaasPaymentMethod";

COMMIT;

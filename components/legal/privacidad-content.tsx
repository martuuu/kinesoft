import Link from "next/link";
import { BRAND_NAME } from "@/lib/brand";
import { LEGAL_ENTITY, TERMS_PATH } from "@/lib/legal";
import { LegalDocument, legalEntityLine, type EntityData, type LegalSection } from "./legal-document";
import s from "./legal-document.module.css";

/**
 * [LG-P] Contenido de `/privacidad` (PV §27, bloque LG): los puntos (1)…(13) del brief, en ese orden.
 *
 * Ojo al editar:
 * - Los dos textos de la Disp. AAIP 10/2008 (sección «Tus derechos») van LITERALES: son obligatorios con esa redacción
 *   (mayúsculas y «Nº»/«N°» incluidos). `tests/unit/lg-p-legal-pages.test.tsx` [LG-3] los compara letra por letra.
 * - La lista de cookies la vigila [LG-2]: si el código suma una cookie `kine_*`/`ks_*` y no se declara acá, falla.
 * - `SUBPROCESSORS` también lo usa `/terminos` (acuerdo de tratamiento): una sola lista de proveedores y regiones.
 * - Un cambio sustancial de este texto es una versión nueva (`LEGAL_VERSION` en `lib/legal.ts`): se vuelve a pedir la
 *   aceptación a todos.
 */

/** Proveedores que tratan datos por cuenta nuestra (subencargados), con su región. Literal del brief PV. */
export const SUBPROCESSORS: { name: string; region: string; what: string }[] = [
  { name: "Supabase", region: "São Paulo, sa-east-1", what: "base de datos, archivos e ingreso a la cuenta" },
  { name: "Vercel", region: "São Paulo, gru1", what: "servidores donde corre la aplicación" },
  { name: "Upstash", region: "sa-east-1", what: "límites de uso y protección contra abusos" },
  { name: "Resend", region: "EE. UU.", what: "envío de emails (recordatorios, avisos, accesos)" },
  { name: "Mercado Pago", region: "Argentina", what: "cobro de la suscripción y cobros online de los consultorios" },
  {
    // claim-ok: prisma/schema.prisma:2513 (WA, M15: `WhatsAppAccount` del consultorio; Meta es encargado real)
    name: "Meta WhatsApp Business",
    region: "EE. UU., solo si se conecta",
    // claim-ok: prisma/schema.prisma:2513
    what: "mensajes por WhatsApp, si el consultorio conecta su número",
  },
  { name: "Sentry", region: "EE. UU.", what: "registro de errores técnicos, sin contenido clínico" },
];

/** Cookies propias y necesarias (sección «Cookies»). Ver [LG-2]. */
const COOKIES: { name: string; what: string }[] = [
  { name: "sb-…-auth-token", what: "mantiene tu sesión iniciada." },
  { name: "kine_session_mode", what: "recuerda si elegiste mantener la sesión abierta en este dispositivo." },
  { name: "kine_idle", what: "cierra la sesión después de un rato sin uso." },
  { name: "kine_tenant", what: "recuerda qué consultorio tenés abierto, si trabajás en más de uno." },
  { name: "kine_2fa", what: "confirma que pasaste la verificación en dos pasos." },
  { name: "kine_stepup", what: "confirma que volviste a verificar tu identidad antes de una acción sensible." },
  { name: "kine_support", what: "marca un acceso de soporte autorizado (solo la usa el equipo de soporte)." },
  { name: "kine_platform_reauth", what: "verificación extra del equipo que administra la plataforma." },
  { name: "kine_mp_oauth", what: "protege la conexión de una cuenta de Mercado Pago; se borra al terminar." },
  // claim-ok: lib/whatsapp/crypto.ts:117 (la cookie la firma `startWhatsAppConnect`)
  { name: "kine_wa_signup", what: "protege la conexión de un número de WhatsApp Business; se borra al terminar." },
  { name: "kine_tv", what: "identifica una pantalla de sala de espera vinculada al consultorio." },
  { name: "ks_recovery", what: "permite usar una sola vez el link para restablecer tu contraseña." },
];

export const AAIP_ACCESS_NOTICE =
  "El titular de los datos personales tiene la facultad de ejercer el derecho de acceso a los mismos en forma gratuita a intervalos no inferiores a seis meses, salvo que se acredite un interés legítimo al efecto conforme lo establecido en el artículo 14, inciso 3 de la Ley Nº 25.326.";
export const AAIP_AUTHORITY_NOTICE =
  "La AGENCIA DE ACCESO A LA INFORMACIÓN PÚBLICA, en su carácter de Órgano de Control de la Ley N° 25.326, tiene la atribución de atender las denuncias y reclamos que interpongan quienes resulten afectados en sus derechos por incumplimiento de las normas vigentes en materia de protección de datos personales.";

export const PRIVACY_CONTACT_HREF = "/contacto?motivo=privacidad";

function sections(entity: EntityData): LegalSection[] {
  const operator = legalEntityLine(entity);
  return [
    {
      id: "quienes-somos",
      title: "Quiénes somos",
      content: (
        <>
          <p>
            {BRAND_NAME} es un sistema en línea para consultorios de kinesiología, osteopatía y otras disciplinas de
            salud: agenda y turnos, pacientes, historia clínica, planes de tratamiento y cobros.
            {operator && ` ${operator}.`}
          </p>
          <p>
            En esta política, «nosotros» es {BRAND_NAME}; «el consultorio» es quien contrata el servicio (su Titular y su
            equipo), y «paciente» es cada persona que el consultorio atiende.
          </p>
        </>
      ),
    },
    {
      id: "roles",
      title: "Quién es responsable de cada dato",
      content: (
        <>
          <p>Hay dos situaciones distintas:</p>
          <ul>
            <li>
              <strong>Datos de los pacientes.</strong> El responsable es cada consultorio: decide qué carga y para qué.
              Nosotros los tratamos solo por cuenta del consultorio y siguiendo sus instrucciones, como prestadores de un
              servicio de tratamiento de datos (Ley 25.326, art. 25). No los usamos para otros fines, no los vendemos ni
              los cedemos a nadie.
            </li>
            <li>
              <strong>Datos de tu cuenta y de contacto</strong> (tu nombre, email, teléfono, los datos del consultorio
              para la suscripción y lo que nos escribís en un ticket). El responsable somos nosotros.
            </li>
          </ul>
        </>
      ),
    },
    {
      id: "datos",
      title: "Qué datos tratamos",
      content: (
        <ul>
          <li>
            <strong>Cuenta:</strong> nombre, email, teléfono, contraseña (guardada cifrada, nunca en texto) y, si la
            activás, la verificación en dos pasos.
          </li>
          <li>
            <strong>Consultorio:</strong> nombre, dirección, sedes, profesionales, servicios, precios y datos de
            facturación de la suscripción.
          </li>
          <li>
            <strong>Pacientes:</strong> datos de contacto e identificación, cobertura, turnos, pagos y la historia clínica.
            La información de salud es un <strong>dato sensible</strong> (Ley 25.326, art. 2): la carga el consultorio y
            se protege con las medidas de la sección «Seguridad».
          </li>
          <li>
            <strong>Tickets de soporte y consultas:</strong> lo que nos escribís y tus datos de contacto.
          </li>
          <li>
            <strong>Registros técnicos:</strong> fecha, dirección IP, navegador y errores, para seguridad y para
            resolver fallas. No incluyen contenido clínico.
          </li>
        </ul>
      ),
    },
    {
      id: "finalidades",
      title: "Para qué los usamos",
      content: (
        <>
          <ul>
            <li>Prestar el servicio: que el consultorio pueda trabajar con su agenda, sus pacientes y sus cobros.</li>
            <li>Cuidar la seguridad de las cuentas y prevenir abusos.</li>
            <li>Cobrar la suscripción.</li>
            <li>
              Enviar avisos por email (recordatorios de turnos, accesos, avisos de la cuenta) y, solo si el consultorio
              lo activa, por WhatsApp.{/* // claim-ok: prisma/schema.prisma:2513 (avisos de WA, M15) */}
            </li>
            <li>Responder tus consultas y tickets de soporte.</li>
          </ul>
          <p>No usamos los datos para publicidad ni los compartimos con anunciantes.</p>
        </>
      ),
    },
    {
      id: "proveedores",
      title: "Proveedores y transferencias internacionales",
      content: (
        <>
          <p>Para dar el servicio usamos estos proveedores, que tratan datos por nuestra cuenta:</p>
          <ul>
            {SUBPROCESSORS.map((p) => (
              <li key={p.name}>
                <strong>
                  {p.name} ({p.region})
                </strong>
                : {p.what}.
              </li>
            ))}
            <li>
              <strong>Google y Facebook</strong>: solo si elegís ingresar con tu cuenta de alguno de ellos (es opcional).
            </li>
          </ul>
          <p>
            Cuando un proveedor está fuera de la Argentina, la transferencia se hace con cláusulas contractuales que
            protegen los datos según la Disposición AAIP 60-E/2016.
          </p>
        </>
      ),
    },
    {
      id: "soporte",
      title: "Acceso del equipo de soporte",
      content: (
        <p>
          Si para resolver un problema necesitamos entrar a la cuenta de un consultorio, el acceso queda registrado, le
          avisamos por email al Titular y lo puede ver en Configuración → Soporte → Accesos de soporte. Durante ese
          acceso vemos datos administrativos, <strong>nunca la historia clínica</strong>,
          y solo cambiamos configuración.
        </p>
      ),
    },
    {
      id: "seguridad",
      title: "Seguridad",
      content: (
        <ul>
          <li>Conexión cifrada (HTTPS) en todo el sitio.</li>
          <li>Cifrado de los datos guardados, provisto por nuestro proveedor de base de datos.</li>
          <li>Aislamiento por consultorio en la base de datos: un consultorio no puede ver los datos de otro.</li>
          <li>Credenciales de terceros (Mercado Pago, WhatsApp) guardadas selladas, nunca en texto.{/* // claim-ok: prisma/schema.prisma:2556 (`WhatsAppCredential`, token sellado) */}</li>
          <li>Verificación en dos pasos para las cuentas de los consultorios.</li>
          <li>Copias de seguridad periódicas.</li>
          <li>Registro de auditoría de las acciones sensibles.</li>
        </ul>
      ),
    },
    {
      id: "retencion",
      title: "Cuánto tiempo guardamos los datos",
      content: (
        <ul>
          <li>Mientras la cuenta del consultorio esté activa.</li>
          <li>
            Después de la baja, el consultorio tiene 90 días para descargar el export completo de sus datos. Pasado ese
            plazo los borramos, salvo lo que una ley nos obligue a conservar.
          </li>
          <li>
            Conservar la historia clínica durante el plazo legal (Ley 26.529, art. 18: al menos 10 años) es una
            obligación de cada consultorio. Por eso tiene siempre disponible el export completo.
          </li>
          <li>Los registros técnicos, 12 meses.</li>
        </ul>
      ),
    },
    {
      id: "derechos",
      title: "Tus derechos",
      content: (
        <>
          <p>
            Podés pedir acceso, rectificación, actualización o supresión de tus datos (derechos ARCO) desde{" "}
            <Link href={PRIVACY_CONTACT_HREF} prefetch={false}>
              el formulario de privacidad
            </Link>
            . Si sos paciente de un consultorio, escribile primero a tu consultorio: es el responsable de tus datos y
            nosotros lo ayudamos a responder.
          </p>
          <p className={s.notice}>{AAIP_ACCESS_NOTICE}</p>
          <p className={s.notice}>{AAIP_AUTHORITY_NOTICE}</p>
        </>
      ),
    },
    {
      id: "cookies",
      title: "Cookies",
      content: (
        <>
          <p>Usamos solo cookies necesarias para que el servicio funcione y sea seguro:</p>
          <ul>
            {COOKIES.map((c) => (
              <li key={c.name}>
                <code>{c.name}</code>: {c.what}
              </li>
            ))}
          </ul>
          <p>
            También guardamos en tu navegador (localStorage) preferencias de apariencia y de vistas, como el tema o el
            orden de una lista. Sin analítica ni publicidad.
          </p>
        </>
      ),
    },
    {
      id: "menores",
      title: "Menores de edad",
      content: (
        <p>
          Los datos de pacientes menores de edad los carga el consultorio, junto con los de su representante legal. El
          servicio no está pensado para que lo usen menores por su cuenta.
        </p>
      ),
    },
    {
      id: "cambios",
      title: "Cambios en esta política",
      content: (
        <p>
          Si cambiamos algo importante, te avisamos por email con 15 días de anticipación. La versión vigente y su
          fecha están siempre arriba de esta página. Ver también los{" "}
          <Link href={TERMS_PATH} prefetch={false}>
            Términos y condiciones
          </Link>
          .
        </p>
      ),
    },
    {
      id: "contacto",
      title: "Contacto",
      content: (
        <p>
          Para cualquier consulta sobre tus datos, escribinos desde{" "}
          <Link href={PRIVACY_CONTACT_HREF} prefetch={false}>
            el formulario de privacidad
          </Link>
          : se abre un ticket y te respondemos por email.
        </p>
      ),
    },
  ];
}

export function PrivacidadContent({ entity = LEGAL_ENTITY }: { entity?: EntityData } = {}) {
  return (
    <LegalDocument
      title="Política de privacidad"
      entity={entity}
      lead={
        <p>
          Esta política explica qué datos trata {BRAND_NAME}, para qué, con quién los compartimos y cómo podés ejercer
          tus derechos.
        </p>
      }
      sections={sections(entity)}
    />
  );
}

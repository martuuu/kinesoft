import Link from "next/link";
import { BRAND_NAME } from "@/lib/brand";
import { LEGAL_ENTITY, PRIVACY_PATH } from "@/lib/legal";
import { LegalDocument, legalEntityLine, type EntityData, type LegalSection } from "./legal-document";
import { SUBPROCESSORS } from "./privacidad-content";

/**
 * [LG-P] Contenido de `/terminos` (PV §27, bloque LG): los puntos del brief, en ese orden. El acuerdo de tratamiento
 * de datos (Ley 25.326, art. 25) va adentro de los términos y lista los MISMOS subencargados que la política
 * (`SUBPROCESSORS`), para que las dos páginas no se contradigan.
 *
 * Sin plazos ni montos inventados: la duración de la prueba y los precios viven en la página de precios y en la
 * cuenta; acá solo lo que no cambia con el plan (cobro el día 4, MPS-D7; tope de responsabilidad; 15 días de aviso).
 * Un cambio sustancial = versión nueva (`LEGAL_VERSION`): se vuelve a pedir la aceptación.
 */

const CONTACT_HREF = "/contacto";

function sections(entity: EntityData): LegalSection[] {
  const operator = legalEntityLine(entity);
  return [
    {
      id: "aceptacion",
      title: "Qué es y cómo se aceptan estos términos",
      content: (
        <>
          <p>
            {BRAND_NAME} es un sistema en línea para gestionar consultorios de salud: agenda y turnos, pacientes,
            historia clínica, planes de tratamiento y cobros.{operator && ` ${operator}.`}
          </p>
          <p>
            Al crear una cuenta, sumarte a un consultorio o usar el servicio, aceptás estos términos y la{" "}
            <Link href={PRIVACY_PATH} prefetch={false}>
              Política de privacidad
            </Link>
            . Si no estás de acuerdo, no uses el servicio.
          </p>
        </>
      ),
    },
    {
      id: "cuentas",
      title: "Cuentas",
      content: (
        <ul>
          <li>
            Cada consultorio tiene un Titular, que responde por el uso que hace su equipo (profesionales, Secretaría y
            demás personas que invita).
          </li>
          <li>
            Las credenciales son personales: no las compartas. Si sospechás que alguien entró a tu cuenta, cambiá la
            contraseña y avisanos.
          </li>
          <li>Los datos que cargás tienen que ser verdaderos y estar actualizados.</li>
        </ul>
      ),
    },
    {
      id: "planes-y-pagos",
      title: "Planes y pagos",
      content: (
        <ul>
          <li>Podés empezar con un período de prueba. Al terminar, para seguir usando el servicio elegís un plan.</li>
          <li>La suscripción es una cuota mensual que se cobra el día 4 de cada mes.</li>
          <li>
            Si un pago no entra, te avisamos. Si sigue sin pagarse, la cuenta pasa a solo lectura y, más adelante, se
            suspende. Aun así, la historia clínica siempre se puede consultar y exportar.
          </li>
          <li>Si cambiás de plan a mitad de mes, se cobra o se descuenta la diferencia proporcional.</li>
          <li>Podés dar de baja la suscripción cuando quieras, sin penalidad.</li>
        </ul>
      ),
    },
    {
      id: "datos-de-pacientes",
      title: "Datos de pacientes: acuerdo de tratamiento",
      content: (
        <>
          <p>
            El consultorio es el responsable de los datos de sus pacientes. {BRAND_NAME} los trata por su cuenta, como
            prestador de servicios de tratamiento de datos (Ley 25.326, art. 25). En ese rol nos comprometemos a:
          </p>
          <ul>
            <li>Tratar los datos solo según las instrucciones del consultorio y para prestar el servicio.</li>
            <li>Mantenerlos confidenciales, también por parte de nuestro equipo.</li>
            <li>Aplicar las medidas de seguridad descriptas en la Política de privacidad.</li>
            <li>
              Usar solo estos subencargados:{" "}
              {SUBPROCESSORS.map((p) => `${p.name} (${p.region})`).join("; ")}.
            </li>
            <li>Ayudar al consultorio a responder los pedidos de acceso, rectificación y supresión de sus pacientes.</li>
            <li>Avisarle sin demora si ocurre un incidente de seguridad que afecte sus datos.</li>
            <li>Al terminar el servicio, darle el export de sus datos y después borrarlos.</li>
          </ul>
        </>
      ),
    },
    {
      id: "uso-aceptable",
      title: "Uso aceptable",
      content: (
        <p>
          No se puede usar el servicio para actividades ilegales, para cargar datos sin la base legal correspondiente,
          para enviar mensajes no pedidos, ni para intentar acceder a datos de otros consultorios, vulnerar la seguridad o
          sobrecargar el sistema.
        </p>
      ),
    },
    {
      id: "herramientas-clinicas",
      title: "Herramientas clínicas",
      content: (
        <p>
          Las herramientas clínicas (diagnóstico, planes, ejercicios y maniobras) son una orientación. Nunca reemplazan
          el criterio del profesional, que es quien decide y responde por la atención de cada paciente.
        </p>
      ),
    },
    {
      id: "cobros-online",
      title: "Cobros online",
      content: (
        <p>
          Si el consultorio activa los cobros online, la plata de cada cobro va directo a la cuenta de Mercado Pago del
          consultorio o del profesional, no a {BRAND_NAME}. Los reintegros a pacientes y la relación con ellos por esos
          cobros son responsabilidad de quien cobra.
        </p>
      ),
    },
    {
      // claim-ok: prisma/schema.prisma:2513 (WA, M15: cláusula de WhatsApp Business del consultorio)
      id: "whatsapp",
      // claim-ok: prisma/schema.prisma:2513
      title: "WhatsApp",
      content: (
        <p>
          {/* // claim-ok: prisma/schema.prisma:2513 */}
          Si el consultorio conecta su número de WhatsApp Business, los mensajes se envían bajo las condiciones de Meta,
          que el consultorio acepta al conectarlo.
        </p>
      ),
    },
    {
      id: "disponibilidad",
      title: "Disponibilidad y soporte",
      content: (
        <p>
          Hacemos lo posible para que el servicio esté disponible siempre, pero puede haber interrupciones por
          mantenimiento o fallas de proveedores. El soporte se da por tickets, desde{" "}
          <Link href={CONTACT_HREF} prefetch={false}>
            el formulario de contacto
          </Link>{" "}
          o desde Configuración → Soporte.
        </p>
      ),
    },
    {
      id: "propiedad",
      title: "Propiedad intelectual y tus datos",
      content: (
        <p>
          El software y la marca son de {BRAND_NAME}. Los datos que cargás son tuyos: podés exportarlos cuando quieras.
        </p>
      ),
    },
    {
      id: "responsabilidad",
      title: "Limitación de responsabilidad",
      content: (
        <p>
          En la medida que lo permita la ley, la responsabilidad total de {BRAND_NAME} frente a un consultorio tiene
          como tope lo que ese consultorio pagó por el servicio en los últimos 12 meses.
        </p>
      ),
    },
    {
      id: "suspension-y-baja",
      title: "Suspensión y baja",
      content: (
        <p>
          Podemos suspender una cuenta por falta de pago o por un uso que viole estos términos, con aviso previo salvo
          urgencia de seguridad. Si das de baja la cuenta, tenés 90 días para descargar el export completo de tus datos;
          después se borran, salvo lo que una ley obligue a conservar.
        </p>
      ),
    },
    {
      id: "cambios",
      title: "Cambios en estos términos",
      content: (
        <p>
          Si cambiamos algo importante, te avisamos por email con 15 días de anticipación. La versión vigente y su fecha
          están siempre arriba de esta página.
        </p>
      ),
    },
    {
      id: "ley-aplicable",
      title: "Ley aplicable y jurisdicción",
      content: (
        <p>
          Estos términos se rigen por la ley argentina. Ante cualquier conflicto, son competentes los{" "}
          {entity.jurisdiction}.
        </p>
      ),
    },
    {
      id: "contacto",
      title: "Contacto",
      content: (
        <p>
          Para cualquier consulta sobre estos términos, escribinos desde{" "}
          <Link href={CONTACT_HREF} prefetch={false}>
            el formulario de contacto
          </Link>
          : se abre un ticket y te respondemos por email.
        </p>
      ),
    },
  ];
}

export function TerminosContent({ entity = LEGAL_ENTITY }: { entity?: EntityData } = {}) {
  return (
    <LegalDocument
      title="Términos y condiciones"
      entity={entity}
      lead={
        <p>
          Estas son las reglas para usar {BRAND_NAME}. Las escribimos para que se entiendan: si algo no queda claro,
          escribinos.
        </p>
      }
      sections={sections(entity)}
    />
  );
}

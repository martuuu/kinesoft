import { PageHeader } from "@/components/ui/page-header";
import { getPlatformWhatsAppOverview } from "@/lib/platform-whatsapp-read";
import { WhatsAppOverview } from "@/components/plataforma/whatsapp/whatsapp-overview";

// Nunca cacheado: es el modo de ESTE deploy y el estado de las cuentas en este momento.
export const dynamic = "force-dynamic";
export const metadata = { title: "WhatsApp · Plataforma" };

/**
 * WA-U6 · El guard del layout es UX; la barrera real es el `requirePlatformAdmin` de `getPlatformWhatsAppOverview`.
 * Con `WHATSAPP_MODE=off` la lectura no consulta tablas y la vista dice que está apagado.
 */
export default async function PlataformaWhatsAppPage() {
  const overview = await getPlatformWhatsAppOverview();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <PageHeader
        eyebrow="Plataforma"
        title="WhatsApp"
        description={
          <>
            Cómo está la integración con Meta en este deploy y la cuenta de cada consultorio: estado, calidad, plantillas y
            mensajes de la última semana. Sin teléfonos: ni el del consultorio ni los de los pacientes.
          </>
        }
      />
      <WhatsAppOverview overview={overview} />
    </div>
  );
}

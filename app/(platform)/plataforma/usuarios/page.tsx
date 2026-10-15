import { Card } from "@/components/ui/card";
import { searchPlatformUsers } from "@/lib/platform-users-read";
import { UserList } from "@/components/plataforma/users/user-list";
import { parseUsersQuery } from "@/components/plataforma/users/users-logic";

export const dynamic = "force-dynamic";
export const metadata = { title: "Usuarios · Plataforma · KineSoft" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * /plataforma/usuarios — directorio global (BO3-D, plan §19.5). Los filtros viven en la URL (`?q=&kind=&page=`).
 * El guard de superadmin está en `app/(platform)/layout.tsx`, y `searchPlatformUsers` vuelve a llamar a
 * `requirePlatformAdmin` (el layout es UX, no la barrera).
 */
export default async function PlataformaUsuariosPage({ searchParams }: { searchParams: SearchParams }) {
  const query = parseUsersQuery(searchParams);
  const page = await searchPlatformUsers(query);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <Card style={{ padding: 24 }}>
        <h1 className="k-display" style={{ fontSize: 26, margin: 0 }}>
          Usuarios
        </h1>
        <p style={{ color: "var(--navy-500)", fontSize: 13.5, marginTop: 6, marginBottom: 0, maxWidth: 640, lineHeight: 1.45 }}>
          Todas las cuentas de KineSoft: equipos de los consultorios y pacientes del portal. Buscá por email o nombre
          para ver su acceso, mandarle un link o deshabilitarla.
        </p>
      </Card>
      <UserList page={page} query={{ ...query, page: page.page }} />
    </div>
  );
}

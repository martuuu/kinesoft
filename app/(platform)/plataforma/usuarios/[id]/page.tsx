import { notFound } from "next/navigation";
import { requirePlatformAdmin } from "@/lib/platform-actor";
import { getPlatformUser } from "@/lib/platform-users-read";
import { UserDetailView } from "@/components/plataforma/users/user-detail";

export const dynamic = "force-dynamic";
export const metadata = { title: "Usuario · Plataforma · KineSoft" };

/**
 * /plataforma/usuarios/[id] — detalle y acciones (BO3-D). `requirePlatformAdmin` acá solo para saber quién mira
 * (no se ofrece «Deshabilitar» sobre uno mismo; el server igual lo rechaza). Es la misma foto memoizada del
 * request que usa el layout.
 */
export default async function PlataformaUsuarioPage({ params }: { params: { id: string } }) {
  const [actor, user] = await Promise.all([requirePlatformAdmin(), getPlatformUser(params.id)]);
  if (!user) notFound();
  return <UserDetailView user={user} actorId={actor.userId} />;
}

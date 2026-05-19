import { NextResponse } from "next/server";
import { getPublicBookingStatus } from "@/lib/public-booking";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public status endpoint — polled by the post-MP success/pending pages.
 *
 * No auth required: the booking id is a high-entropy CUID, so leaking
 * presence of a booking from an unguessable id is acceptable. The
 * response is the minimum needed to render the confirmation screen.
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const r = await getPublicBookingStatus(params.id);
  if (!r) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json(r, { headers: { "Cache-Control": "no-store" } });
}

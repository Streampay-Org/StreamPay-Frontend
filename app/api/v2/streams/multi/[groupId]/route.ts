import { NextResponse } from "next/server";
import { getStore } from "@/app/lib/db";
import { getCorrelationContext } from "@/app/lib/logger";
import { buildMultiGroupManifest, type MultiGroupLeg } from "./group";

type Context = { params: Promise<{ groupId: string }> };

function errorResponse(code: string, message: string, status: number) {
  return NextResponse.json(
    {
      error: {
        code,
        message,
        request_id: getCorrelationContext()?.request_id ?? `req-${crypto.randomUUID()}`,
      },
    },
    { status },
  );
}

/** GET /api/v2/streams/multi/:groupId — current fan-out manifest. */
export async function GET(request: Request, { params }: Context) {
  if (!request.headers.get("authorization")) {
    return errorResponse("UNAUTHORIZED", "Bearer token required.", 401);
  }

  const { groupId } = await params;
  const { streamRepository } = getStore();
  const legs = streamRepository
    .getMultiGroupStreamIds(groupId)
    .map((id) => streamRepository.streams.get(id))
    .filter((leg): leg is MultiGroupLeg => Boolean(leg && (leg as MultiGroupLeg).multiGroupId === groupId));

  if (legs.length === 0) {
    return errorResponse("STREAM_GROUP_NOT_FOUND", `Stream group '${groupId}' not found.`, 404);
  }

  return NextResponse.json(buildMultiGroupManifest(groupId, legs));
}
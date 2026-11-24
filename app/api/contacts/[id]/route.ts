import { NextResponse, type NextRequest } from "next/server";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { getStore } from "@/app/lib/db";
import { resolveRequestId, REQUEST_ID_HEADER } from "@/lib/requestId";
import { validateRow } from "@/app/contacts/importExport";
import type { SyncedContact } from "@/app/contacts/sync";

function errorResponse(request: NextRequest, code: string, message: string, status: number) {
  const requestId = resolveRequestId(request.headers);
  return NextResponse.json(
    { error: { code, message, request_id: requestId } },
    { status, headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}

/**
 * PUT /api/contacts/[id] — create or update a single contact.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const actor = tryAuthenticateRequest(request);
  if (!actor) {
    return errorResponse(request, "UNAUTHORIZED", "Missing or invalid authorization header", 401);
  }

  const { id } = params;
  if (!id) {
    return errorResponse(request, "BAD_REQUEST", "Contact id is required", 400);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(request, "BAD_REQUEST", "Invalid JSON body", 400);
  }

  const contact = body as Partial<SyncedContact>;
  if (!contact || typeof contact !== "object") {
    return errorResponse(request, "BAD_REQUEST", "Body must be a contact object", 400);
  }

  if (!contact.label || typeof contact.label !== "string") {
    return errorResponse(request, "VALIDATION_ERROR", "Contact missing label", 400);
  }

  const validation = validateRow({
    label: contact.label,
    address: contact.address ?? "",
  });
  if (!validation.valid) {
    return errorResponse(request, "VALIDATION_ERROR", validation.reason ?? "Invalid contact", 400);
  }

  // Ensure cross-wallet isolation: if this contact id exists for a different wallet,
  // return 403. For the same wallet it's an upsert.
  const existing = getStore().contactsStore.getById(actor.walletAddress, id);
  if (existing && existing.id !== id) {
    return errorResponse(request, "CONFLICT", "Contact id mismatch", 409);
  }

  const now = new Date().toISOString();
  const synced: SyncedContact = {
    id,
    label: contact.label,
    address: contact.address ?? existing?.address ?? "",
    federationAddress: contact.federationAddress,
    memo: contact.memo,
    requiredMemo: contact.requiredMemo,
    createdAt: existing?.createdAt ?? contact.createdAt ?? now,
    updatedAt: contact.updatedAt ?? now,
    deletedAt: undefined,
  };

  getStore().contactsStore.upsert(actor.walletAddress, synced);
  return NextResponse.json({ contact: synced });
}

/**
 * DELETE /api/contacts/[id] — tombstone a single contact.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const actor = tryAuthenticateRequest(request);
  if (!actor) {
    return errorResponse(request, "UNAUTHORIZED", "Missing or invalid authorization header", 401);
  }

  const { id } = params;
  const existing = getStore().contactsStore.getById(actor.walletAddress, id);
  if (!existing) {
    return errorResponse(request, "NOT_FOUND", "Contact not found", 404);
  }

  getStore().contactsStore.delete(actor.walletAddress, id);
  return NextResponse.json({ deleted: true, id });
}

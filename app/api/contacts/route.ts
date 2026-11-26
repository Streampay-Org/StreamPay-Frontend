import { NextResponse, type NextRequest } from "next/server";
import { tryAuthenticateRequest } from "@/app/lib/auth";
import { getStore } from "@/app/lib/db";
import { resolveRequestId, REQUEST_ID_HEADER } from "@/lib/requestId";
import { validateRow, MAX_IMPORT_ROWS } from "@/app/contacts/importExport";
import type { SyncedContact } from "@/app/contacts/sync";

function errorResponse(request: NextRequest, code: string, message: string, status: number) {
  const requestId = resolveRequestId(request.headers);
  return NextResponse.json(
    { error: { code, message, request_id: requestId } },
    { status, headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}

/**
 * GET /api/contacts — list all contacts for the authenticated wallet.
 */
export async function GET(request: NextRequest) {
  const actor = tryAuthenticateRequest(request);
  if (!actor) {
    return errorResponse(request, "UNAUTHORIZED", "Missing or invalid authorization header", 401);
  }

  const contacts = getStore().contactsStore.getForWallet(actor.walletAddress);
  // Filter out tombstoned contacts for the list response
  const active = contacts.filter((c) => !c.deletedAt);
  return NextResponse.json({ contacts: active });
}

/**
 * PUT /api/contacts — replace all contacts for the authenticated wallet.
 * Body: { contacts: SyncedContact[] }
 */
export async function PUT(request: NextRequest) {
  const actor = tryAuthenticateRequest(request);
  if (!actor) {
    return errorResponse(request, "UNAUTHORIZED", "Missing or invalid authorization header", 401);
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse(request, "BAD_REQUEST", "Invalid JSON body", 400);
  }

  if (!body || typeof body !== "object" || !Array.isArray((body as { contacts?: unknown }).contacts)) {
    return errorResponse(request, "BAD_REQUEST", "Body must be { contacts: [...] }", 400);
  }

  const contacts = (body as { contacts: SyncedContact[] }).contacts;

  if (contacts.length > MAX_IMPORT_ROWS) {
    return errorResponse(request, "PAYLOAD_TOO_LARGE", `Maximum ${MAX_IMPORT_ROWS} contacts allowed`, 413);
  }

  // Validate each contact using the same validation as importExport.ts
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    if (!c.id || typeof c.id !== "string") {
      return errorResponse(request, "VALIDATION_ERROR", `Contact at index ${i} missing id`, 400);
    }
    if (!c.label || typeof c.label !== "string") {
      return errorResponse(request, "VALIDATION_ERROR", `Contact at index ${i} missing label`, 400);
    }
    const validation = validateRow({ label: c.label, address: c.address });
    if (!validation.valid) {
      return errorResponse(request, "VALIDATION_ERROR", `Contact ${c.id}: ${validation.reason}`, 400);
    }
    if (!c.createdAt || typeof c.createdAt !== "string") {
      return errorResponse(request, "VALIDATION_ERROR", `Contact ${c.id} missing createdAt`, 400);
    }
    if (!c.updatedAt || typeof c.updatedAt !== "string") {
      return errorResponse(request, "VALIDATION_ERROR", `Contact ${c.id} missing updatedAt`, 400);
    }
  }

  getStore().contactsStore.setForWallet(actor.walletAddress, contacts);
  return NextResponse.json({ contacts });
}

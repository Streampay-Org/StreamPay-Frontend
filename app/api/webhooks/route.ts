import { NextRequest, NextResponse } from 'next/server';
import { withAccessLog } from '@/src/middleware/accessLog';

async function postHandler(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch (err) {
    return NextResponse.json({
      error: {
        code: 'INVALID_JSON',
        message: 'Request body must be valid JSON.'
      }
    }, { status: 400 });
  }

  // Input validation at the boundary
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({
      error: {
        code: 'INVALID_PAYLOAD',
        message: 'Payload must be a JSON object.'
      }
    }, { status: 400 });
  }

  // Here you would typically process the webhook payload.
  // For the purpose of this endpoint and missing schema details, we acknowledge receipt.
  
  return NextResponse.json({
    status: 'ok',
    message: 'Webhook received successfully.'
  }, { status: 200 });
}

export const POST = withAccessLog(postHandler);

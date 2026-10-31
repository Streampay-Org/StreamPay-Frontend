# Idempotency reservation protocol

request -> read committed result -> atomic KeyValueStore.insert(in-flight)
                                      | existing -> replay or 409 + Retry-After
                                      v
                                   handler
                                      | 2xx / 400,404,409,422 -> owner-checked commit
                                      | 429 / 5xx / exception -> owner-checked release

Reservations expire after IDEMPOTENCY_INFLIGHT_TTL_MS (default 30 seconds).
A live request is additionally guarded within the process. Expired owners cannot
overwrite a newer reservation or an existing committed success. Records and
reservations remain scoped by resource and actor as before. Raw keys are not logged.

The existing memory KeyValueStore provides a synchronous create-only insert.
The repository's PostgreSQL adapter currently throws for these operations; it
therefore fails closed with 503 instead of silently executing an unprotected
financial mutation. A future shared database adapter must implement an atomic
create-only insert and owner-conditional updates before supporting this protocol
across independent processes.
